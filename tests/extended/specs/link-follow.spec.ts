// @ts-nocheck

import { test, expect, BASE_CONFIG, loadConfig, waitForPageEventsConfig, resetCaptured } from './fixtures.js'

const TEST_ORIGIN = 'https://pages.test'
const PAGE_READY_MS = 1000
const SETTLE_MS = 1000
const SHORT_WINDOW_MS = 1000
const PAST_SHORT_WINDOW_MS = 2000
const SCRIPT_NAVIGATION_DELAY_MS = 2000
const LATE_FRAGMENT_DELAY_MS = 500
const NEXT_PAGE = '<!doctype html><title>Next</title><p>Next</p>'
const FOLLOWING_ON = { allow_all: true, event_types: { link_follow: true } }

let pageCount = 0

async function startModule(serviceWorker, pageEvents = FOLLOWING_ON) {
  const config = { ...BASE_CONFIG, page_events: { enabled: true, ...pageEvents } }

  await loadConfig(serviceWorker, config)
  await waitForPageEventsConfig(serviceWorker)
  await resetCaptured(serviceWorker)
}

async function openTestPage(context, body) {
  pageCount += 1

  const url = `${TEST_ORIGIN}/follow-page-${pageCount}`
  const html = `<!doctype html><html><head><title>Follow page ${pageCount}</title></head><body>${body}</body></html>`

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

async function followSameTabLink(page, selector = '#link') {
  await Promise.all([page.waitForURL('**/destination'), page.click(selector)])
}

const SAME_TAB_LINK = '<a id="link" href="/destination">Result title</a>'
const NEW_TAB_LINK = '<a id="link" href="/destination" target="_blank">Result title</a>'
const CLAIMED_SAME_TAB_LINK = `<div class="claimable">${SAME_TAB_LINK}</div>`
const STOPPED_LINK = '<a id="link" href="/destination" onclick="event.preventDefault()">Result title</a>'
const CLAIMED_STOPPED_LINK = `<div class="claimable">${STOPPED_LINK}</div>`
const FRAGMENT_LINK = '<a id="fragment" href="#top">Top</a>'
const LATE_FRAGMENT_LINK =
  `<a id="late-fragment" href="#later" onclick="event.preventDefault(); setTimeout(() => { location.hash = 'later' }, ${LATE_FRAGMENT_DELAY_MS})">Later</a>`
const SCRIPT_LINK = '<a id="script" href="javascript:void(0)">Script</a>'
const CLAIMED_LATE_SCRIPT_NAVIGATION =
  `<div class="claimable"><span id="go" onclick="setTimeout(() => { location.href = '/destination' }, ${SCRIPT_NAVIGATION_DELAY_MS})">Go</span></div>`

test.describe('link_follow records', () => {
  test('clicking a link that navigates in the same tab records a same_tab link_follow', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const { page, url } = await openTestPage(context, SAME_TAB_LINK)
    await followSameTabLink(page)

    await expect.poll(async () => (await followsOf(serviceWorker)).length).toBe(1)

    const [click] = await clicksOf(serviceWorker)
    const [follow] = await followsOf(serviceWorker)

    expect(follow).toMatchObject({
      name: 'rex-page-event',
      click_id: click.click_id,
      session_id: click.session_id,
      tab_id: click.tab_id,
      url,
      open_mode: 'same_tab',
      target_tab_id: click.tab_id,
      is_result: false,
    })
    expect('matched_by' in follow).toBe(false)
  })

  test('a target=_blank link records a new_tab link_follow with target_tab_id', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const { page, url } = await openTestPage(context, NEW_TAB_LINK)
    await Promise.all([context.waitForEvent('page'), page.click('#link')])

    await expect.poll(async () => (await followsOf(serviceWorker)).length).toBe(1)

    const [click] = await clicksOf(serviceWorker)
    const [follow] = await followsOf(serviceWorker)
    const newTabOpen = (await eventsOf(serviceWorker, 'tab_open')).find((event) => event.opener_tab_id === click.tab_id)

    expect(follow).toMatchObject({
      click_id: click.click_id,
      session_id: click.session_id,
      tab_id: click.tab_id,
      url,
      open_mode: 'new_tab',
      matched_by: 'opener',
      is_result: false,
    })
    expect(newTabOpen).toBeDefined()
    expect(follow.target_tab_id).toBe(newTabOpen.tab_id)
    expect(follow.target_tab_id).not.toBe(click.tab_id)
  })

  test('a claimed click that navigates records is_result true', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const { page } = await openTestPage(context, CLAIMED_SAME_TAB_LINK)
    await followSameTabLink(page)

    await expect.poll(async () => (await followsOf(serviceWorker)).length).toBe(1)

    const [follow] = await followsOf(serviceWorker)

    expect(follow.open_mode).toBe('same_tab')
    expect(follow.is_result).toBe(true)
  })

  test('with link following off (the default), a link click records its click and no link_follow', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker, { allow_all: true })

    const { page } = await openTestPage(context, SAME_TAB_LINK)
    await followSameTabLink(page)

    await expect.poll(async () => (await clicksOf(serviceWorker)).length).toBe(1)
    await page.waitForTimeout(SETTLE_MS)

    expect(await followsOf(serviceWorker)).toEqual([])
  })

  test('a click on a page that is not allowed records its click and no link_follow', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker, { event_types: { link_follow: true } })

    const { page } = await openTestPage(context, SAME_TAB_LINK)
    await followSameTabLink(page)

    await expect.poll(async () => (await clicksOf(serviceWorker)).length).toBe(1)
    await page.waitForTimeout(SETTLE_MS)

    expect(await followsOf(serviceWorker)).toEqual([])
  })

  test('an unclaimed click with no navigation records no link_follow', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker, { ...FOLLOWING_ON, link_follow_match_window: SHORT_WINDOW_MS })

    const { page } = await openTestPage(context, STOPPED_LINK)
    await page.click('#link')
    await page.waitForTimeout(PAST_SHORT_WINDOW_MS)

    expect((await clicksOf(serviceWorker)).length).toBe(1)
    expect(await followsOf(serviceWorker)).toEqual([])
  })

  test('a claimed click with no navigation records open_mode none after the window', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker, { ...FOLLOWING_ON, link_follow_match_window: SHORT_WINDOW_MS })

    const { page } = await openTestPage(context, CLAIMED_STOPPED_LINK)
    await page.click('#link')
    await page.waitForTimeout(PAST_SHORT_WINDOW_MS)

    const [click] = await clicksOf(serviceWorker)
    const follows = await followsOf(serviceWorker)

    expect(follows.length).toBe(1)
    expect(follows[0]).toMatchObject({ click_id: click.click_id, tab_id: click.tab_id, open_mode: 'none', is_result: true })
    expect('target_tab_id' in follows[0]).toBe(false)
    expect('matched_by' in follows[0]).toBe(false)
  })

  test('a right-click on a claimed link with no navigation gives its click record and no link_follow', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker, { ...FOLLOWING_ON, link_follow_match_window: SHORT_WINDOW_MS })

    const { page } = await openTestPage(context, CLAIMED_SAME_TAB_LINK)
    await page.click('#link', { button: 'right' })
    await page.waitForTimeout(PAST_SHORT_WINDOW_MS)

    const clicks = await clicksOf(serviceWorker)

    expect(clicks.length).toBe(1)
    expect(clicks[0]).toMatchObject({ click_type: 'right', claimed: true })
    expect(await followsOf(serviceWorker)).toEqual([])
  })

  test('a right-click on a link, then a new tab the page opens by script, gives no link_follow', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const { page } = await openTestPage(context, SAME_TAB_LINK)
    await page.click('#link', { button: 'right' })
    await expect.poll(async () => (await clicksOf(serviceWorker)).length).toBe(1)
    await Promise.all([context.waitForEvent('page'), page.evaluate(() => { window.open('/destination') })])
    await page.waitForTimeout(SETTLE_MS)

    const [click] = await clicksOf(serviceWorker)
    const newTabOpen = (await eventsOf(serviceWorker, 'tab_open')).find((event) => event.opener_tab_id === click.tab_id)

    expect(click.click_type).toBe('right')
    expect(newTabOpen).toBeDefined()
    expect(await followsOf(serviceWorker)).toEqual([])
  })

  test('a fragment-only or javascript: link records on_link true and no link_follow', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const { page } = await openTestPage(context, [FRAGMENT_LINK, LATE_FRAGMENT_LINK, SCRIPT_LINK].join(''))
    await page.click('#fragment')
    await page.waitForURL('**#top')
    await page.click('#late-fragment')
    await page.waitForURL('**#later')
    await page.click('#script')
    await page.waitForTimeout(SETTLE_MS)

    const clicks = await clicksOf(serviceWorker)

    expect(clicks.length).toBe(3)
    expect(clicks.every((click) => click.on_link === true)).toBe(true)
    expect(await followsOf(serviceWorker)).toEqual([])
  })

  test('a double click on a link gives one link_follow for the second click', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker, { ...FOLLOWING_ON, link_follow_match_window: SHORT_WINDOW_MS })

    const { page } = await openTestPage(context, CLAIMED_SAME_TAB_LINK)
    await Promise.all([page.waitForURL('**/destination'), page.dblclick('#link')])
    await page.waitForTimeout(PAST_SHORT_WINDOW_MS)

    const clicks = await clicksOf(serviceWorker)
    const follows = await followsOf(serviceWorker)
    const secondClick = clicks.find((click) => click.click_count === 2)

    expect(clicks.map((click) => click.click_count).sort()).toEqual([1, 2])
    expect(follows.length).toBe(1)
    expect(follows[0].click_id).toBe(secondClick.click_id)
    expect(follows[0].open_mode).toBe('same_tab')
  })

  test('link_follow_match_window set to 1000 stops matching after 1000 ms', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker, { ...FOLLOWING_ON, link_follow_match_window: SHORT_WINDOW_MS })

    const { page } = await openTestPage(context, CLAIMED_LATE_SCRIPT_NAVIGATION)
    await Promise.all([page.waitForURL('**/destination'), page.click('#go')])
    await page.waitForTimeout(SETTLE_MS)

    const follows = await followsOf(serviceWorker)

    expect(follows.length).toBe(1)
    expect(follows[0].open_mode).toBe('none')
  })

  for (const invalidWindow of ['soon', 0, -1000]) {
    test(`an invalid value uses 5000 (${JSON.stringify(invalidWindow)})`, async ({ context, serviceWorker }) => {
      await startModule(serviceWorker, { ...FOLLOWING_ON, link_follow_match_window: invalidWindow })

      const { page } = await openTestPage(context, CLAIMED_LATE_SCRIPT_NAVIGATION)
      await Promise.all([page.waitForURL('**/destination'), page.click('#go')])

      await expect.poll(async () => (await followsOf(serviceWorker)).length).toBe(1)

      const [follow] = await followsOf(serviceWorker)

      expect(follow.open_mode).toBe('same_tab')
    })
  }
})
