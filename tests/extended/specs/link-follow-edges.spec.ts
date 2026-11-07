// @ts-nocheck

import { test, expect, BASE_CONFIG, loadConfig, waitForPageEventsConfig, resetCaptured } from './fixtures.js'

const TEST_ORIGIN = 'https://pages.test'
const DESTINATION_URL = `${TEST_ORIGIN}/destination`
const OTHER_URL = `${TEST_ORIGIN}/other`
const PAGE_READY_MS = 1000
const SHORT_WINDOW_MS = 1000
const PAST_SHORT_WINDOW_MS = 2000
const SETTLE_MS = 1500
const SCRIPT_NAVIGATION_DELAY_MS = 300
const FOLLOWING_ON = { allow_all: true, event_types: { link_follow: true } }
const NEXT_PAGE = '<!doctype html><title>Next</title><p>Next</p>'

let pageCount = 0

async function startModule(serviceWorker, pageEvents = FOLLOWING_ON) {
  const config = { ...BASE_CONFIG, page_events: { enabled: true, ...pageEvents } }

  await loadConfig(serviceWorker, config)
  await waitForPageEventsConfig(serviceWorker)
  await resetCaptured(serviceWorker)
}

async function openTestPage(context, body) {
  pageCount += 1

  const url = `${TEST_ORIGIN}/edge-page-${pageCount}`
  const html = `<!doctype html><html><head><title>Edge page ${pageCount}</title></head><body>${body}</body></html>`

  await context.route('**/*', async (route) => {
    const requestUrl = new URL(route.request().url())

    if (requestUrl.origin !== TEST_ORIGIN) {
      return route.abort()
    }

    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: requestUrl.href === url ? html : NEXT_PAGE })
  })

  const page = await context.newPage()

  await page.goto(url, { waitUntil: 'load' })
  await page.waitForTimeout(PAGE_READY_MS)

  return { page, url }
}

function eventsOf(serviceWorker, eventType) {
  return serviceWorker.evaluate((type) => self.__capturedEvents.filter((event) => event.event_type === type), eventType)
}

const clicksOf = (serviceWorker) => eventsOf(serviceWorker, 'click')
const followsOf = (serviceWorker) => eventsOf(serviceWorker, 'link_follow')
const endsOf = (serviceWorker) => eventsOf(serviceWorker, 'link_follow_end')

function createWindowWithoutOpener(serviceWorker, address) {
  return serviceWorker.evaluate((url) => chrome.windows.create({ url, focused: false }).then((created) => created.id), address)
}

const STOPPED_LINK = '<a id="link" href="/destination" onclick="event.preventDefault()">Result title</a>'
const CLAIMED_ADDRESSLESS_SCRIPT_LINK =
  `<div class="claimable"><div id="link" role="link" onclick="setTimeout(() => { location.href = '/destination' }, ${SCRIPT_NAVIGATION_DELAY_MS})">Result title</div></div>`
const CLAIMED_ADDRESSLESS_INERT_LINK = '<div class="claimable"><div id="link" role="link">Result title</div></div>'

test.describe('a new window with no opener', () => {
  test('matches a Shift-click on its address', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const { page, url } = await openTestPage(context, STOPPED_LINK)
    await page.click('#link', { modifiers: ['Shift'] })
    await expect.poll(async () => (await clicksOf(serviceWorker)).length).toBe(1)

    const windowId = await createWindowWithoutOpener(serviceWorker, DESTINATION_URL)

    await expect.poll(async () => (await followsOf(serviceWorker)).length).toBe(1)

    const [click] = await clicksOf(serviceWorker)
    const [follow] = await followsOf(serviceWorker)
    const newTabOpen = (await eventsOf(serviceWorker, 'tab_open')).find((event) => event.window_id === windowId)

    expect(newTabOpen).toBeDefined()
    expect('opener_tab_id' in newTabOpen).toBe(false)
    expect(follow).toMatchObject({
      click_id: click.click_id,
      tab_id: click.tab_id,
      url,
      open_mode: 'new_window',
      matched_by: 'address_and_time',
      target_tab_id: newTabOpen.tab_id,
    })
  })

  test('matches when the tab event arrives before the window event', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const { page } = await openTestPage(context, STOPPED_LINK)
    await page.click('#link', { modifiers: ['Shift'] })
    await expect.poll(async () => (await clicksOf(serviceWorker)).length).toBe(1)

    await serviceWorker.evaluate((address) => {
      const plugin = self.rexPageEventsPlugin
      const tab = { id: 987001, windowId: 987002, index: 0, active: true, pendingUrl: address, url: '' }

      plugin.enqueue(() => plugin.onTabCreated(tab))
      plugin.enqueue(() => plugin.onWindowCreated({ id: 987002 }))
    }, DESTINATION_URL)

    await expect.poll(async () => (await followsOf(serviceWorker)).length).toBe(1)

    const [click] = await clicksOf(serviceWorker)
    const [follow] = await followsOf(serviceWorker)

    expect(follow).toMatchObject({
      click_id: click.click_id,
      open_mode: 'new_window',
      matched_by: 'address_and_time',
      target_tab_id: 987001,
    })
  })

  test('control: a window at another address does not match', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker, { ...FOLLOWING_ON, link_follow_match_window: SHORT_WINDOW_MS })

    const { page } = await openTestPage(context, STOPPED_LINK)
    await page.click('#link', { modifiers: ['Shift'] })
    await expect.poll(async () => (await clicksOf(serviceWorker)).length).toBe(1)
    await createWindowWithoutOpener(serviceWorker, OTHER_URL)
    await page.waitForTimeout(PAST_SHORT_WINDOW_MS)

    expect(await followsOf(serviceWorker)).toEqual([])
  })

  test('control: without Shift it does not match', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker, { ...FOLLOWING_ON, link_follow_match_window: SHORT_WINDOW_MS })

    const { page } = await openTestPage(context, STOPPED_LINK)
    await page.click('#link')
    await expect.poll(async () => (await clicksOf(serviceWorker)).length).toBe(1)
    await createWindowWithoutOpener(serviceWorker, DESTINATION_URL)
    await page.waitForTimeout(PAST_SHORT_WINDOW_MS)

    expect(await followsOf(serviceWorker)).toEqual([])
  })

  test('control: a window created after the match window does not match', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker, { ...FOLLOWING_ON, link_follow_match_window: SHORT_WINDOW_MS })

    const { page } = await openTestPage(context, STOPPED_LINK)
    await page.click('#link', { modifiers: ['Shift'] })
    await expect.poll(async () => (await clicksOf(serviceWorker)).length).toBe(1)
    await page.waitForTimeout(PAST_SHORT_WINDOW_MS)
    await createWindowWithoutOpener(serviceWorker, DESTINATION_URL)
    await page.waitForTimeout(SETTLE_MS)

    expect(await followsOf(serviceWorker)).toEqual([])
  })
})

test.describe('a claimed click on an element with no address', () => {
  test('then a same-tab address change records a same_tab follow', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const { page } = await openTestPage(context, CLAIMED_ADDRESSLESS_SCRIPT_LINK)
    await Promise.all([page.waitForURL('**/destination'), page.click('#link')])
    await expect.poll(async () => (await followsOf(serviceWorker)).length).toBe(1)

    const [click] = await clicksOf(serviceWorker)
    const [follow] = await followsOf(serviceWorker)

    expect(click).toMatchObject({ claimed: true, on_link: false })
    expect('link_url' in click).toBe(false)
    expect(follow).toMatchObject({
      click_id: click.click_id,
      tab_id: click.tab_id,
      open_mode: 'same_tab',
      target_tab_id: click.tab_id,
      is_result: true,
    })
  })

  test('with no navigation records open_mode none and no link_follow_end', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker, { ...FOLLOWING_ON, link_follow_match_window: SHORT_WINDOW_MS })

    const { page } = await openTestPage(context, CLAIMED_ADDRESSLESS_INERT_LINK)
    await page.click('#link')
    await page.waitForTimeout(PAST_SHORT_WINDOW_MS)

    const [click] = await clicksOf(serviceWorker)
    const follows = await followsOf(serviceWorker)

    expect(follows.length).toBe(1)
    expect(follows[0]).toMatchObject({ click_id: click.click_id, open_mode: 'none', is_result: true })
    expect(await endsOf(serviceWorker)).toEqual([])
  })

  test('control: an unclaimed click on an element with no address records no link_follow', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker, { ...FOLLOWING_ON, link_follow_match_window: SHORT_WINDOW_MS })

    const { page } = await openTestPage(context, '<div id="link" role="link">Result title</div>')
    await page.click('#link')
    await page.waitForTimeout(PAST_SHORT_WINDOW_MS)

    expect((await clicksOf(serviceWorker)).length).toBe(1)
    expect(await followsOf(serviceWorker)).toEqual([])
  })
})
