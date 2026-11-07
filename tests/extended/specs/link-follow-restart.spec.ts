// @ts-nocheck

import { test, expect, BASE_CONFIG, loadConfig, waitForPageEventsConfig, resetCaptured } from './fixtures.js'
import { evaluateInRestartedWorker, stopServiceWorker } from './worker-restart.js'

const TEST_ORIGIN = 'https://pages.test'
const OUTSIDE_ORIGIN = 'https://elsewhere.test'
const DESTINATION_URL = `${TEST_ORIGIN}/destination`
const PAGE_READY_MS = 1000
const DWELL_MS = 1000
const AWAY_MS = 1500
const SETTLE_MS = 1000
const SHORT_WINDOW_MS = 1000
const PAST_SHORT_WINDOW_MS = 2000
const REARMED_WINDOW_MS = 3000
const WAKE_AFTER_STOP_MS = 500
const SCRIPT_NAVIGATION_DELAY_MS = 2500
const NAVIGATION_AFTER_CLICK_MS = 200
const QUEUE_ALLOWANCE_MS = 500
const FOLLOWING_ON = { allow_all: true, event_types: { link_follow: true } }
const NEXT_PAGE = '<!doctype html><title>Next</title><p>Next</p>'
const TALL = '<div style="height: 5000px">Tall page</div>'

const SAME_TAB_LINK = '<a id="link" href="/destination">Result title</a>'
const STOPPED_LINK = '<a id="link" href="/destination" onclick="event.preventDefault()">Result title</a>'
const CLAIMED_STOPPED_LINK = `<div class="claimable">${STOPPED_LINK}</div>`
const CLAIMED_LATE_SCRIPT_NAVIGATION =
  `<div class="claimable"><span id="go" onclick="setTimeout(() => { location.href = '/destination' }, ${SCRIPT_NAVIGATION_DELAY_MS})">Go</span></div>`

let pageCount = 0

async function startModule(serviceWorker, pageEvents = FOLLOWING_ON) {
  const config = { ...BASE_CONFIG, page_events: { enabled: true, ...pageEvents } }

  await loadConfig(serviceWorker, config)
  await waitForPageEventsConfig(serviceWorker)
  await resetCaptured(serviceWorker)
}

function pageHtml(title, body) {
  return `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`
}

async function openSource(context, body) {
  pageCount += 1

  const url = `${TEST_ORIGIN}/restart-source-${pageCount}`
  const html = pageHtml(`Restart source ${pageCount}`, `${body}${TALL}`)

  await context.route('**/*', async (route) => {
    const requestUrl = new URL(route.request().url())

    if (!requestUrl.hostname.endsWith('.test')) {
      return route.abort()
    }

    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: requestUrl.href === url ? html : NEXT_PAGE })
  })

  const page = await context.newPage()

  await page.goto(url, { waitUntil: 'load' })
  await page.waitForTimeout(PAGE_READY_MS)

  return { page, url }
}

function capturedEvents(serviceWorker) {
  return serviceWorker.evaluate(() => self.__capturedEvents)
}

async function loadRecordOf(serviceWorker, url) {
  await expect.poll(async () => (await capturedEvents(serviceWorker)).filter((event) => event.event_type === 'load' && event.url === url).length)
    .toBeGreaterThanOrEqual(1)

  return (await capturedEvents(serviceWorker)).find((event) => event.event_type === 'load' && event.url === url)
}

async function restartedEventsOf(context, probe, eventType) {
  const events = (await evaluateInRestartedWorker(context, probe, 'self.__capturedEvents')) ?? []

  return events.filter((event) => event.event_type === eventType)
}

async function waitForRestartedEvents(context, probe, eventType) {
  await expect.poll(async () => (await restartedEventsOf(context, probe, eventType)).length, { timeout: 8000 }).toBeGreaterThanOrEqual(1)

  return restartedEventsOf(context, probe, eventType)
}

async function startWithAllowList(serviceWorker) {
  await serviceWorker.evaluate(async () => {
    await self.createListEntry({
      list_name: 'restart-allow',
      pattern: 'pages.test',
      pattern_type: 'host',
      source: 'backend',
      metadata: { category: 'ALLOWED' },
    })
  })
  await startModule(serviceWorker, { allow_lists: ['restart-allow'], event_types: { link_follow: true } })
}

function deliverNavigationBeforeClick(context, probe, { tabId, windowId, sourceUrl, destinationUrl, clickId }) {
  const expression = `(() => {
    const plugin = self.rexPageEventsPlugin
    const tab = { id: ${tabId}, windowId: ${windowId}, url: ${JSON.stringify(sourceUrl)}, title: 'Source', active: true }
    const message = {
      messageType: 'pageClick',
      click_id: ${JSON.stringify(clickId)},
      url: ${JSON.stringify(sourceUrl)},
      title: 'Source',
      timestamp: Date.now() - ${NAVIGATION_AFTER_CLICK_MS},
      click_type: 'primary',
      button: 0,
      modifier_keys: [],
      click_count: 1,
      on_link: true,
      link_url: ${JSON.stringify(destinationUrl)},
      link_text: 'Result title',
      claim: {},
    }

    plugin.enqueue(() => plugin.onTabUrlChanged(${tabId}, ${JSON.stringify(destinationUrl)}, { ...tab, url: ${JSON.stringify(destinationUrl)} }))
    plugin.enqueue(() => plugin.recordClick(message, { tab }))
    return true
  })()`

  return evaluateInRestartedWorker(context, probe, expression)
}

test.describe('link following across a service worker stop', () => {
  test('a click that wakes a stopped worker is recorded', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const probe = await context.newPage()
    const { page, url } = await openSource(context, STOPPED_LINK)
    const load = await loadRecordOf(serviceWorker, url)

    await stopServiceWorker(context, probe)
    await page.click('#link')

    const clicks = await waitForRestartedEvents(context, probe, 'click')

    expect(clicks).toHaveLength(1)
    expect(clicks[0]).toMatchObject({ tab_id: load.tab_id, session_id: load.session_id, url, on_link: true })
  })

  test('a navigation reaching a just-woken worker before its click still matches', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker, { ...FOLLOWING_ON, link_follow_match_window: SHORT_WINDOW_MS })

    const probe = await context.newPage()
    const { page, url } = await openSource(context, '')
    const load = await loadRecordOf(serviceWorker, url)

    await stopServiceWorker(context, probe)
    await page.mouse.wheel(0, 600)
    await deliverNavigationBeforeClick(context, probe, {
      tabId: load.tab_id,
      windowId: load.window_id,
      sourceUrl: url,
      destinationUrl: DESTINATION_URL,
      clickId: 'navigation-first',
    })

    await waitForRestartedEvents(context, probe, 'link_follow')
    await page.waitForTimeout(PAST_SHORT_WINDOW_MS)

    const follows = await restartedEventsOf(context, probe, 'link_follow')

    expect(follows).toHaveLength(1)
    expect(follows[0]).toMatchObject({
      click_id: 'navigation-first',
      tab_id: load.tab_id,
      open_mode: 'same_tab',
      target_tab_id: load.tab_id,
      is_result: true,
    })
  })

  test('a follow open across a stop keeps its time in front and ends once', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const probe = await context.newPage()
    const { page } = await openSource(context, SAME_TAB_LINK)
    await page.bringToFront()

    await Promise.all([page.waitForURL('**/destination'), page.click('#link')])
    await page.waitForLoadState('load')
    await expect.poll(async () => (await capturedEvents(serviceWorker)).filter((event) => event.event_type === 'link_follow').length).toBe(1)
    await page.waitForTimeout(DWELL_MS)

    await stopServiceWorker(context, probe)
    await page.waitForTimeout(AWAY_MS)

    const beforeBackMs = Date.now()
    await page.goBack({ waitUntil: 'load' })
    const afterBackMs = Date.now()

    await waitForRestartedEvents(context, probe, 'link_follow_end')
    await page.waitForTimeout(SETTLE_MS)

    const ends = await restartedEventsOf(context, probe, 'link_follow_end')

    expect(ends).toHaveLength(1)
    expect(ends[0].end_reason).toBe('back')
    expect(typeof ends[0].shown_at).toBe('number')
    expect(ends[0].total_focus_duration_ms).toBeGreaterThanOrEqual(beforeBackMs - ends[0].shown_at - QUEUE_ALLOWANCE_MS)
    expect(ends[0].total_focus_duration_ms).toBeLessThanOrEqual(afterBackMs - ends[0].shown_at + QUEUE_ALLOWANCE_MS)
  })

  test('a click pending across a stop matches the navigation that wakes the worker', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const probe = await context.newPage()
    const { page, url } = await openSource(context, CLAIMED_LATE_SCRIPT_NAVIGATION)
    const load = await loadRecordOf(serviceWorker, url)

    await page.click('#go')
    await expect.poll(async () => (await capturedEvents(serviceWorker)).filter((event) => event.event_type === 'click').length).toBe(1)
    const [click] = (await capturedEvents(serviceWorker)).filter((event) => event.event_type === 'click')

    await stopServiceWorker(context, probe)
    await page.waitForURL('**/destination')

    const follows = await waitForRestartedEvents(context, probe, 'link_follow')

    expect(follows).toHaveLength(1)
    expect(follows[0]).toMatchObject({ click_id: click.click_id, tab_id: load.tab_id, open_mode: 'same_tab', is_result: true })
  })

  test('a claimed click pending across a stop still expires to open_mode none, once', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker, { ...FOLLOWING_ON, link_follow_match_window: REARMED_WINDOW_MS })

    const probe = await context.newPage()
    const { page } = await openSource(context, CLAIMED_STOPPED_LINK)

    await page.click('#link')
    await expect.poll(async () => (await capturedEvents(serviceWorker)).filter((event) => event.event_type === 'click').length).toBe(1)
    const [click] = (await capturedEvents(serviceWorker)).filter((event) => event.event_type === 'click')

    await stopServiceWorker(context, probe)
    await page.waitForTimeout(WAKE_AFTER_STOP_MS)
    await page.mouse.wheel(0, 600)
    await page.waitForTimeout(REARMED_WINDOW_MS + SETTLE_MS)

    const follows = await restartedEventsOf(context, probe, 'link_follow')

    expect(follows).toHaveLength(1)
    expect(follows[0]).toMatchObject({ click_id: click.click_id, open_mode: 'none', is_result: true })
  })

  test('a claimed click whose window ran out during a stop records open_mode none once the worker wakes', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker, { ...FOLLOWING_ON, link_follow_match_window: SHORT_WINDOW_MS })

    const probe = await context.newPage()
    const { page } = await openSource(context, CLAIMED_STOPPED_LINK)

    await page.click('#link')
    await expect.poll(async () => (await capturedEvents(serviceWorker)).filter((event) => event.event_type === 'click').length).toBe(1)
    const [click] = (await capturedEvents(serviceWorker)).filter((event) => event.event_type === 'click')

    await stopServiceWorker(context, probe)
    await page.waitForTimeout(PAST_SHORT_WINDOW_MS)
    await page.mouse.wheel(0, 600)

    await waitForRestartedEvents(context, probe, 'link_follow')
    await page.waitForTimeout(SETTLE_MS)

    const follows = await restartedEventsOf(context, probe, 'link_follow')

    expect(follows).toHaveLength(1)
    expect(follows[0]).toMatchObject({ click_id: click.click_id, open_mode: 'none' })
  })

  test('a follow whose target tab state is lost across a stop records 0 ms in front, never less', async ({ context, serviceWorker }) => {
    await startWithAllowList(serviceWorker)

    const probe = await context.newPage()
    const { page, url } = await openSource(context, `<a id="link" href="${OUTSIDE_ORIGIN}/destination">Result title</a>`)
    const load = await loadRecordOf(serviceWorker, url)
    await page.bringToFront()
    await page.waitForTimeout(DWELL_MS)

    await Promise.all([page.waitForURL(`${OUTSIDE_ORIGIN}/destination`), page.click('#link')])
    await page.waitForLoadState('load')
    await page.waitForTimeout(DWELL_MS)

    await serviceWorker.evaluate((tabId) => chrome.storage.session.get('rexPageEventsTabState').then((saved) =>
      chrome.storage.session.set({ rexPageEventsTabState: saved.rexPageEventsTabState.filter(([savedTabId]) => savedTabId !== tabId) })
    ), load.tab_id)
    await stopServiceWorker(context, probe)
    await page.goto(`${TEST_ORIGIN}/search?q=next`, { waitUntil: 'load' })

    const ends = await waitForRestartedEvents(context, probe, 'link_follow_end')

    expect(ends).toHaveLength(1)
    expect(ends[0].end_reason).toBe('allow_listed_page')
    expect(ends[0].total_focus_duration_ms).toBe(0)
  })
})

test.describe('followStateFrom', () => {
  test('rebuilds the open follows and window creation times as maps', async ({ serviceWorker }) => {
    const restored = await serviceWorker.evaluate(() => {
      const state = self.followStateRules.followStateFrom({
        pending: [{ clickId: 'p1' }],
        open: [['o1', { clickId: 'o1', targetTabId: 7 }]],
        heldNewTabs: [{ tabId: 8, createdAtMs: 100 }],
        heldNavigations: [{ tabId: 9, atMs: 200 }],
        windowCreations: [[5, 1000]],
      })

      return {
        openIsMap: state.open instanceof Map,
        openTarget: state.open.get('o1')?.targetTabId,
        windowCreationsIsMap: state.windowCreations instanceof Map,
        windowCreatedAt: state.windowCreations.get(5),
        pending: state.pending.map((click) => click.clickId),
        heldNewTabs: state.heldNewTabs.map((held) => held.tabId),
        heldNavigations: state.heldNavigations.map((held) => held.tabId),
      }
    })

    expect(restored).toEqual({
      openIsMap: true,
      openTarget: 7,
      windowCreationsIsMap: true,
      windowCreatedAt: 1000,
      pending: ['p1'],
      heldNewTabs: [8],
      heldNavigations: [9],
    })
  })

  test('gives an empty state when nothing was saved', async ({ serviceWorker }) => {
    const restored = await serviceWorker.evaluate(() => {
      const state = self.followStateRules.followStateFrom(undefined)

      return [state.pending.length, state.open.size, state.heldNewTabs.length, state.heldNavigations.length, state.windowCreations.size]
    })

    expect(restored).toEqual([0, 0, 0, 0, 0])
  })
})
