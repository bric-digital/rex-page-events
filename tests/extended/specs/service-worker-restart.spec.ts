import { type BrowserContext, type CDPSession, type Page, type Worker } from '@playwright/test'

import { test, expect, BASE_CONFIG, loadConfig, waitForPageEventsConfig, resetCaptured } from './fixtures.js'

const TEST_ORIGIN = 'https://pages.test'
const SETTLE_MS = 2000
const TALL_PAGE = '<div style="height: 5000px">Tall page</div>'
const QUEUE_ALLOWANCE_MS = 500
const SLOW_CONFIGURATION_READ_MS = 1500

interface CapturedEvent {
  event_type?: string
  tab_id?: number
  session_id?: string
  url?: string
  [field: string]: unknown
}

interface TargetInfo {
  targetId: string
  type: string
}

let pageCount = 0

async function startModule(serviceWorker: Worker) {
  await loadConfig(serviceWorker, BASE_CONFIG)
  await waitForPageEventsConfig(serviceWorker)
  await resetCaptured(serviceWorker)
}

async function openTestPage(context: BrowserContext, body: string) {
  pageCount += 1

  const url = `${TEST_ORIGIN}/page-${pageCount}`
  const html = `<!doctype html><html><head><title>Test page ${pageCount}</title></head><body>${body}</body></html>`

  const page = await context.newPage()

  await page.route('**/*', async (route) => {
    const requestUrl = new URL(route.request().url())

    if (requestUrl.origin !== TEST_ORIGIN) {
      return route.abort()
    }

    const pageHtml = requestUrl.href === url ? html : '<!doctype html><title>Next</title><p>Next</p>'

    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: pageHtml })
  })

  await page.goto(url)

  return { page, url }
}

async function workerTargets(cdp: CDPSession): Promise<TargetInfo[]> {
  const { targetInfos } = await cdp.send('Target.getTargets')

  return targetInfos.filter((target: TargetInfo) => target.type === 'service_worker')
}

async function stopServiceWorker(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page)

  await cdp.send('ServiceWorker.enable')
  await cdp.send('ServiceWorker.stopAllWorkers')

  await expect.poll(async () => (await workerTargets(cdp)).length, { timeout: 5000 }).toBe(0)

  await cdp.detach()
}

async function evaluateInRestartedWorker(context: BrowserContext, page: Page, expression: string): Promise<unknown> {
  const cdp = await context.newCDPSession(page)

  await expect.poll(async () => (await workerTargets(cdp)).length, { timeout: 5000 }).toBeGreaterThan(0)

  const [target] = await workerTargets(cdp)
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false })

  const messageId = 1
  const answer = new Promise<unknown>((resolve) => {
    cdp.on('Target.receivedMessageFromTarget', (event) => {
      const message = JSON.parse(event.message)

      if (event.sessionId === sessionId && message.id === messageId) {
        resolve(message.result?.result?.value)
      }
    })
  })

  await cdp.send('Target.sendMessageToTarget', {
    sessionId,
    message: JSON.stringify({
      id: messageId,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true },
    }),
  })

  const value = await answer

  await cdp.detach()

  return value
}

async function capturedBeforeStop(serviceWorker: Worker): Promise<CapturedEvent[]> {
  return serviceWorker.evaluate('self.__capturedEvents') as Promise<CapturedEvent[]>
}

async function restartedCapturedEvents(context: BrowserContext, page: Page): Promise<CapturedEvent[]> {
  const events = await evaluateInRestartedWorker(context, page, 'self.__capturedEvents')

  return (events ?? []) as CapturedEvent[]
}

function tabIdOf(events: CapturedEvent[], url: string): number | undefined {
  return events.find((event) => event.event_type === 'load' && event.url === url)?.tab_id
}

function recordsOf(events: CapturedEvent[], tabId: number | undefined): CapturedEvent[] {
  return events.filter((event) => event.tab_id === tabId)
}

async function waitForRestartedRecord(
  context: BrowserContext,
  probe: Page,
  matches: (event: CapturedEvent) => boolean
): Promise<CapturedEvent[]> {
  await expect.poll(async () => {
    const events = await restartedCapturedEvents(context, probe)

    return events.filter(matches).length
  }, { timeout: 5000 }).toBeGreaterThanOrEqual(1)

  return restartedCapturedEvents(context, probe)
}

function expectBetween(value: unknown, shortestMs: number, longestMs: number) {
  expect(value).toBeGreaterThanOrEqual(shortestMs - QUEUE_ALLOWANCE_MS)
  expect(value).toBeLessThanOrEqual(longestMs + QUEUE_ALLOWANCE_MS)
}

async function savedTabIds(context: BrowserContext, probe: Page): Promise<number[]> {
  const ids = await evaluateInRestartedWorker(
    context,
    probe,
    "chrome.storage.session.get('rexPageEventsTabState').then((saved) => (saved.rexPageEventsTabState ?? []).map((entry) => entry[0]))"
  )

  return ids as number[]
}

test.describe('Service worker restart', () => {
  test('stopping the worker starts a fresh one', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const { page } = await openTestPage(context, TALL_PAGE)
    await page.waitForTimeout(SETTLE_MS)

    await serviceWorker.evaluate("self.__workerMarker = 'before-stop'")
    expect(await serviceWorker.evaluate('self.__workerMarker')).toBe('before-stop')

    await stopServiceWorker(context, page)
    await page.mouse.wheel(0, 600)

    expect(await evaluateInRestartedWorker(context, page, 'self.__workerMarker')).toBeUndefined()
  })

  test('the scroll that wakes a stopped worker is recorded', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const { page, url } = await openTestPage(context, TALL_PAGE)
    await page.waitForTimeout(SETTLE_MS)

    await stopServiceWorker(context, page)
    await page.mouse.wheel(0, 600)

    await expect.poll(async () => {
      const events = await restartedCapturedEvents(context, page)

      return events.filter((event) => event.event_type === 'scroll' && event.url === url).length
    }, { timeout: 5000 }).toBeGreaterThanOrEqual(1)
  })

  test('the tab event that wakes a stopped worker is recorded', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const probe = await context.newPage()
    const { page, url } = await openTestPage(context, TALL_PAGE)
    await page.waitForTimeout(SETTLE_MS)

    const tabId = tabIdOf(await capturedBeforeStop(serviceWorker), url)

    await stopServiceWorker(context, probe)
    await page.goto(`${TEST_ORIGIN}/next`)
    await page.close()
    await probe.waitForTimeout(SETTLE_MS)

    const afterStop = await restartedCapturedEvents(context, probe)

    expect(tabId).toBeDefined()
    expect(afterStop.filter((event) => event.event_type === 'tab_url_change' && event.tab_id === tabId)).toHaveLength(1)
  })

  test('the tab event that wakes a stopped worker waits for a slow configuration read', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const probe = await context.newPage()
    const { page, url } = await openTestPage(context, TALL_PAGE)
    await page.waitForTimeout(SETTLE_MS)

    const tabId = tabIdOf(await capturedBeforeStop(serviceWorker), url)

    await serviceWorker.evaluate(`chrome.storage.session.set({ testConfigurationReadDelayMs: ${SLOW_CONFIGURATION_READ_MS} })`)
    await stopServiceWorker(context, probe)
    await page.goto(`${TEST_ORIGIN}/next`)

    const afterStop = await waitForRestartedRecord(context, probe, (event) => event.event_type === 'tab_url_change')

    expect(tabId).toBeDefined()
    expect(afterStop.filter((event) => event.event_type === 'tab_url_change' && event.tab_id === tabId)).toHaveLength(1)
  })

  test('a navigation and a close during start-up are recorded in order', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const probe = await context.newPage()
    const { page, url } = await openTestPage(context, TALL_PAGE)
    await page.waitForTimeout(SETTLE_MS)

    const tabId = tabIdOf(await capturedBeforeStop(serviceWorker), url)

    await stopServiceWorker(context, probe)
    await page.goto(`${TEST_ORIGIN}/next`)
    await page.close()

    const afterStop = recordsOf(await waitForRestartedRecord(context, probe, (event) => event.event_type === 'tab_close' && event.tab_id === tabId), tabId)
    const eventTypes = afterStop.map((event) => event.event_type)
    const tabClose = afterStop.find((event) => event.event_type === 'tab_close')

    expect(eventTypes.indexOf('tab_url_change')).toBeGreaterThanOrEqual(0)
    expect(eventTypes.indexOf('tab_url_change')).toBeLessThan(eventTypes.indexOf('tab_close'))
    expect(tabClose?.url).toBe(`${TEST_ORIGIN}/next`)
  })

  test('nothing is recorded before the first configuration', async ({ serviceWorker }) => {
    const earlyTabId = await serviceWorker.evaluate("chrome.tabs.create({ url: 'https://example.org/early' }).then((tab) => tab.id)")
    await serviceWorker.evaluate(`new Promise((resolve) => setTimeout(resolve, ${SETTLE_MS}))`)

    await loadConfig(serviceWorker, BASE_CONFIG)
    await waitForPageEventsConfig(serviceWorker)

    const lateTabId = await serviceWorker.evaluate("chrome.tabs.create({ url: 'https://example.org/late' }).then((tab) => tab.id)")

    await expect.poll(async () => {
      const events = await capturedBeforeStop(serviceWorker)

      return events.filter((event) => event.event_type === 'tab_open' && event.tab_id === lateTabId).length
    }, { timeout: 5000 }).toBe(1)

    const events = await capturedBeforeStop(serviceWorker)
    expect(events.filter((event) => event.event_type === 'tab_open' && event.tab_id === earlyTabId)).toEqual([])
  })

  test('a tab keeps its session_id across a stop', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const probe = await context.newPage()
    const { page, url } = await openTestPage(context, TALL_PAGE)
    await page.waitForTimeout(SETTLE_MS)

    const beforeStop = await capturedBeforeStop(serviceWorker)
    const tabId = tabIdOf(beforeStop, url)
    const firstSessionId = recordsOf(beforeStop, tabId)[0]?.session_id

    await stopServiceWorker(context, probe)
    await page.goto(`${TEST_ORIGIN}/next`)
    await page.close()

    const afterStop = recordsOf(await waitForRestartedRecord(context, probe, (event) => event.event_type === 'tab_close' && event.tab_id === tabId), tabId)

    expect(tabId).toBeDefined()
    expect(firstSessionId).toBeDefined()
    expect(afterStop.map((event) => event.session_id)).toEqual(afterStop.map(() => firstSessionId))
    expect(afterStop.filter((event) => event.event_type === 'tab_open')).toEqual([])
  })

  test('a tab keeps its session_id across two stops', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const probe = await context.newPage()
    const { page, url } = await openTestPage(context, TALL_PAGE)
    await page.waitForTimeout(SETTLE_MS)

    const beforeStop = await capturedBeforeStop(serviceWorker)
    const tabId = tabIdOf(beforeStop, url)
    const firstSessionId = recordsOf(beforeStop, tabId)[0]?.session_id

    await stopServiceWorker(context, probe)
    await page.mouse.wheel(0, 600)
    const afterFirstStop = recordsOf(await waitForRestartedRecord(context, probe, (event) => event.event_type === 'scroll' && event.tab_id === tabId), tabId)

    await stopServiceWorker(context, probe)
    await page.goto(`${TEST_ORIGIN}/next`)
    await page.close()
    const afterSecondStop = recordsOf(await waitForRestartedRecord(context, probe, (event) => event.event_type === 'tab_close' && event.tab_id === tabId), tabId)

    const afterStops = [...afterFirstStop, ...afterSecondStop]

    expect(firstSessionId).toBeDefined()
    expect(afterStops.map((event) => event.session_id)).toEqual(afterStops.map(() => firstSessionId))
  })

  test('durations count from when the tab opened', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const probe = await context.newPage()

    const beforeOpenMs = Date.now()
    const { page, url } = await openTestPage(context, TALL_PAGE)
    const afterOpenMs = Date.now()

    await page.bringToFront()
    const afterFocusMs = Date.now()
    await page.waitForTimeout(SETTLE_MS)

    const beforeStop = await capturedBeforeStop(serviceWorker)
    const tabId = tabIdOf(beforeStop, url)
    await page.waitForTimeout(3000)

    await stopServiceWorker(context, probe)

    const beforeLeaveMs = Date.now()
    await page.goto(`${TEST_ORIGIN}/next`)
    const afterLeaveMs = Date.now()

    const beforeCloseMs = Date.now()
    await page.close()
    const afterCloseMs = Date.now()

    const afterStop = recordsOf(await waitForRestartedRecord(context, probe, (event) => event.event_type === 'tab_close' && event.tab_id === tabId), tabId)
    const tabClose = afterStop.find((event) => event.event_type === 'tab_close')
    const leavingFirstPage = afterStop.find((event) => event.event_type === 'tab_url_change' && event.url === url)
    const addressChanges = [...recordsOf(beforeStop, tabId), ...afterStop].filter((event) => event.event_type === 'tab_url_change')
    const totalDwellMs = addressChanges.reduce((total, event) => total + Number(event.url_dwell_ms), 0)

    expectBetween(tabClose?.tab_lifetime_ms, beforeCloseMs - afterOpenMs, afterCloseMs - beforeOpenMs)
    expectBetween(tabClose?.focus_duration_ms, beforeCloseMs - afterFocusMs, afterCloseMs - beforeOpenMs)
    expectBetween(leavingFirstPage?.url_dwell_ms, beforeLeaveMs - afterOpenMs, afterLeaveMs - beforeOpenMs)

    expect(Number(tabClose?.focus_duration_ms)).toBeLessThanOrEqual(Number(tabClose?.tab_lifetime_ms))
    expect(totalDwellMs).toBeLessThanOrEqual(Number(tabClose?.tab_lifetime_ms))
    for (const change of addressChanges) {
      expect(Number(change.url_focus_duration_ms)).toBeLessThanOrEqual(Number(change.url_dwell_ms))
    }
  })

  test('a tab closed right after a stop records tab_close', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const probe = await context.newPage()
    const { page, url } = await openTestPage(context, TALL_PAGE)
    await page.waitForTimeout(SETTLE_MS)

    const tabId = tabIdOf(await capturedBeforeStop(serviceWorker), url)

    await stopServiceWorker(context, probe)
    await page.close()

    const afterStop = recordsOf(await waitForRestartedRecord(context, probe, (event) => event.event_type === 'tab_close' && event.tab_id === tabId), tabId)

    expect(afterStop.filter((event) => event.event_type === 'tab_close')).toHaveLength(1)
    expect(await savedTabIds(context, probe)).not.toContain(tabId)
  })

  test('two tabs keep their own sessions across a stop', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const probe = await context.newPage()
    const first = await openTestPage(context, TALL_PAGE)
    const second = await openTestPage(context, TALL_PAGE)
    await second.page.bringToFront()
    await second.page.waitForTimeout(SETTLE_MS)

    const beforeStop = await capturedBeforeStop(serviceWorker)
    const firstTabId = tabIdOf(beforeStop, first.url)
    const secondTabId = tabIdOf(beforeStop, second.url)
    const firstSessionId = recordsOf(beforeStop, firstTabId)[0]?.session_id
    const secondSessionId = recordsOf(beforeStop, secondTabId)[0]?.session_id

    await stopServiceWorker(context, probe)
    await first.page.bringToFront()

    const afterStop = await waitForRestartedRecord(context, probe, (event) => event.event_type === 'tab_focus' && event.tab_id === firstTabId)
    const firstFocus = afterStop.find((event) => event.event_type === 'tab_focus' && event.tab_id === firstTabId)
    const secondBlur = afterStop.find((event) => event.event_type === 'tab_blur' && event.tab_id === secondTabId)

    expect(firstSessionId).not.toBe(secondSessionId)
    expect(firstFocus?.session_id).toBe(firstSessionId)
    expect(secondBlur?.session_id).toBe(secondSessionId)
  })
})
