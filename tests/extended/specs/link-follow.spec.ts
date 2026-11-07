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

const DESTINATION_URL = `${TEST_ORIGIN}/destination`
const HELD_URL = `${TEST_ORIGIN}/held`
const OUTSIDE_ORIGIN = 'https://elsewhere.test'
const HELD_OUTSIDE_URL = `${OUTSIDE_ORIGIN}/held`
const HELD_OUTSIDE_LINK = `<a id="link" href="${HELD_OUTSIDE_URL}" target="_blank">Result title</a>`
const NEXT_SEARCH_URL = `${TEST_ORIGIN}/search?q=next`
const DWELL_MS = 1000
const AWAY_MS = 1500
const REDIRECT_DELAY_MS = 500
const DATA_DESTINATION = 'data:text/html,<title>Data destination</title><p>Data destination</p>'
const HELD = Symbol('held')
const JUDGMENT_FIELDS = ['outcome', 'used', 'rejected', 'satisfied']

const endsOf = (serviceWorker) => eventsOf(serviceWorker, 'link_follow_end')

function pageHtml(title, body = '') {
  return `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`
}

async function serveSite(context, pages) {
  await context.route('**/*', async (route) => {
    const requestUrl = new URL(route.request().url())
    const page = pages[requestUrl.href]

    if (!requestUrl.hostname.endsWith('.test')) {
      return route.abort()
    }

    if (page === HELD) {
      return undefined
    }

    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: page ?? NEXT_PAGE })
  })
}

async function openSource(context, body, pages = {}) {
  pageCount += 1

  const url = `${TEST_ORIGIN}/source-${pageCount}`

  await serveSite(context, { ...pages, [url]: pageHtml(`Source ${pageCount}`, body) })

  const page = await context.newPage()

  await page.goto(url, { waitUntil: 'load' })
  await page.waitForTimeout(PAGE_READY_MS)

  return { page, url }
}

async function openSourceInNewWindow(context, serviceWorker, body) {
  pageCount += 1

  const url = `${TEST_ORIGIN}/source-${pageCount}`

  await serveSite(context, { [url]: pageHtml(`Source ${pageCount}`, body) })

  const [page, windowId] = await Promise.all([
    context.waitForEvent('page'),
    serviceWorker.evaluate((address) => chrome.windows.create({ url: address, focused: true }).then((created) => created.id), url),
  ])

  await page.waitForLoadState('load')
  await page.waitForTimeout(PAGE_READY_MS)

  return { page, url, windowId }
}

async function startWithAllowList(serviceWorker) {
  await serviceWorker.evaluate(async () => {
    await self.createListEntry({
      list_name: 'follow-allow',
      pattern: 'pages.test',
      pattern_type: 'host',
      source: 'backend',
      metadata: { category: 'ALLOWED' },
    })
  })
  await startModule(serviceWorker, { allow_lists: ['follow-allow'], event_types: { link_follow: true } })
}

async function followSameTabAndDwell(page, selector = '#link', destination = '**/destination') {
  await Promise.all([page.waitForURL(destination), page.click(selector)])
  await page.waitForLoadState('load')
  await page.waitForTimeout(DWELL_MS)
}

async function onlyEnd(serviceWorker) {
  await expect.poll(async () => (await endsOf(serviceWorker)).length).toBe(1)

  const [end] = await endsOf(serviceWorker)

  return end
}

function moveFocusToWindow(serviceWorker, windowId) {
  return serviceWorker.evaluate((id) => {
    const plugin = self.rexPageEventsPlugin

    plugin.enqueue(() => plugin.onWindowFocusChanged(id))
  }, windowId)
}

function createWindow(serviceWorker, address) {
  return serviceWorker.evaluate(
    (url) => chrome.windows.create({ url: url ?? chrome.runtime.getURL('index.html'), focused: true }).then((created) => created.id),
    address,
  )
}

function removeWindow(serviceWorker, windowId) {
  return serviceWorker.evaluate((id) => chrome.windows.remove(id), windowId)
}

const DESTINATION_WITH_NEXT_LINK = pageHtml('Destination', '<a id="next" href="/second">Second</a>')
const REDIRECTING_DESTINATION = pageHtml(
  'Redirecting destination',
  `<script>setTimeout(() => { location.replace('/landing') }, ${REDIRECT_DELAY_MS})</script>`,
)

test.describe('link_follow_end records', () => {
  test('a same-tab follow ended by Back records total_focus_duration_ms and end_reason back', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const { page, url } = await openSource(context, SAME_TAB_LINK)
    await followSameTabAndDwell(page)
    await page.goBack({ waitUntil: 'load' })

    const end = await onlyEnd(serviceWorker)
    const [click] = await clicksOf(serviceWorker)
    const [follow] = await followsOf(serviceWorker)

    expect(end).toMatchObject({
      name: 'rex-page-event',
      click_id: click.click_id,
      session_id: click.session_id,
      tab_id: click.tab_id,
      url,
      url_shown_at: click.url_shown_at,
      destination_url: DESTINATION_URL,
      before_load: false,
      end_reason: 'back',
    })
    expect(follow.url_shown_at).toBe(click.url_shown_at)
    expect(typeof end.shown_at).toBe('number')
    expect(end.first_focused_at).toBe(end.shown_at)
    expect(end.total_focus_duration_ms).toBeGreaterThanOrEqual(800)
    expect(end.total_focus_duration_ms).toBeLessThanOrEqual(3000)
  })

  test('link_follow carries the source page url_shown_at from the click, not a later one', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker, { ...FOLLOWING_ON, link_follow_match_window: SHORT_WINDOW_MS })

    const movingLink = `<div class="claimable"><a id="link" href="/destination" onclick="event.preventDefault(); setTimeout(() => { location.hash = 'moved' }, ${LATE_FRAGMENT_DELAY_MS})">Result title</a></div>`
    const { page } = await openSource(context, movingLink)
    await page.click('#link')
    await page.waitForTimeout(PAST_SHORT_WINDOW_MS)

    const [click] = await clicksOf(serviceWorker)
    const [follow] = await followsOf(serviceWorker)
    const fragmentChange = (await eventsOf(serviceWorker, 'tab_url_change'))
      .find((event) => event.tab_id === click.tab_id && event.timestamp > click.timestamp)

    expect(fragmentChange).toBeDefined()
    expect(follow.open_mode).toBe('none')
    expect(follow.url_shown_at).toBe(click.url_shown_at)
  })

  test('a new search in the same tab ends the follow with allow_listed_page', async ({ context, serviceWorker }) => {
    await startWithAllowList(serviceWorker)

    const { page } = await openSource(context, `<a id="link" href="${OUTSIDE_ORIGIN}/destination">Result title</a>`)
    await followSameTabAndDwell(page)
    await page.goto(`${TEST_ORIGIN}/search?q=next`, { waitUntil: 'load' })

    const end = await onlyEnd(serviceWorker)

    expect(end.end_reason).toBe('allow_listed_page')
    expect(end.destination_url).toBe('CATEGORY:NOT_ON_ALLOWLIST')
    expect(end.before_load).toBe(false)
  })

  for (const { name, link, kept } of [
    { name: 'an unclaimed', link: HELD_OUTSIDE_LINK, kept: 'CATEGORY:NOT_ON_ALLOWLIST' },
    { name: 'a claimed', link: `<div class="claimable" data-claim-destination="${HELD_OUTSIDE_URL}">${HELD_OUTSIDE_LINK}</div>`, kept: OUTSIDE_ORIGIN },
  ]) {
    test(`${name} follow still loading ends with allow_listed_page when its tab reaches an allowed page`, async ({ context, serviceWorker }) => {
      await startWithAllowList(serviceWorker)

      const { page } = await openSource(context, link, { [HELD_OUTSIDE_URL]: HELD })
      await page.click('#link')
      await expect.poll(async () => (await followsOf(serviceWorker)).length).toBe(1)
      await page.waitForTimeout(DWELL_MS)

      const [follow] = await followsOf(serviceWorker)
      await serviceWorker.evaluate(({ tabId, url }) => chrome.tabs.update(tabId, { url }), { tabId: follow.target_tab_id, url: NEXT_SEARCH_URL })

      const end = await onlyEnd(serviceWorker)

      expect(end).toMatchObject({ end_reason: 'allow_listed_page', before_load: true, total_focus_duration_ms: 0 })
      expect(end.destination_url).not.toBe(NEXT_SEARCH_URL)
      expect(end.destination_url).toBe(kept)
      expect('shown_at' in end).toBe(false)
    })
  }

  test('a second follow from the same tab ends the first with new_follow', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const { page } = await openSource(context, SAME_TAB_LINK, { [DESTINATION_URL]: DESTINATION_WITH_NEXT_LINK })
    await followSameTabAndDwell(page)
    await followSameTabAndDwell(page, '#next', '**/second')

    await expect.poll(async () => (await followsOf(serviceWorker)).length).toBe(2)

    const end = await onlyEnd(serviceWorker)
    const [first, second] = await followsOf(serviceWorker)

    expect(end.click_id).toBe(first.click_id)
    expect(end.click_id).not.toBe(second.click_id)
    expect(end.end_reason).toBe('new_follow')
    expect(end.destination_url).toBe(DESTINATION_URL)
  })

  test('a new-tab follow closed records tab_closed', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const { page } = await openSource(context, NEW_TAB_LINK)
    const [destination] = await Promise.all([context.waitForEvent('page'), page.click('#link')])
    await destination.waitForLoadState('load')
    await destination.waitForTimeout(DWELL_MS)
    await destination.close()

    const end = await onlyEnd(serviceWorker)
    const [follow] = await followsOf(serviceWorker)

    expect(end.click_id).toBe(follow.click_id)
    expect(end.end_reason).toBe('tab_closed')
    expect(end.destination_url).toBe(DESTINATION_URL)
    expect(end.before_load).toBe(false)
    expect(typeof end.shown_at).toBe('number')
  })

  test('a new-tab follow never brought to the front records 0 ms', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const { page } = await openSource(context, SAME_TAB_LINK)
    const [destination] = await Promise.all([context.waitForEvent('page'), page.click('#link', { button: 'middle' })])
    await destination.waitForLoadState('load')
    await destination.waitForTimeout(DWELL_MS)
    await destination.close()

    const end = await onlyEnd(serviceWorker)
    const [follow] = await followsOf(serviceWorker)

    expect(follow.open_mode).toBe('new_tab')
    expect(end.end_reason).toBe('tab_closed')
    expect(typeof end.shown_at).toBe('number')
    expect(end.total_focus_duration_ms).toBe(0)
    expect('first_focused_at' in end).toBe(false)
  })

  test('a follow ended before the destination loaded records before_load true and no shown_at', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const { page } = await openSource(context, '<a id="link" href="/held" target="_blank">Result title</a>', { [HELD_URL]: HELD })
    await page.click('#link')
    await expect.poll(async () => (await followsOf(serviceWorker)).length).toBe(1)
    await page.waitForTimeout(DWELL_MS)

    const [follow] = await followsOf(serviceWorker)
    await serviceWorker.evaluate((tabId) => chrome.tabs.remove(tabId), follow.target_tab_id)

    const end = await onlyEnd(serviceWorker)

    expect(end.end_reason).toBe('tab_closed')
    expect(end.before_load).toBe(true)
    expect(end.destination_url).toBe(HELD_URL)
    expect(end.total_focus_duration_ms).toBe(0)
    expect('shown_at' in end).toBe(false)
    expect('first_focused_at' in end).toBe(false)
  })

  test('closing the window ends the follow with window_closed', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const { page, windowId } = await openSourceInNewWindow(context, serviceWorker, SAME_TAB_LINK)
    await followSameTabAndDwell(page)
    await removeWindow(serviceWorker, windowId)

    const end = await onlyEnd(serviceWorker)

    expect(end.end_reason).toBe('window_closed')
    expect(end.destination_url).toBe(DESTINATION_URL)
  })

  test('the destination\'s own redirect does not end the follow', async ({ context, serviceWorker }) => {
    await startWithAllowList(serviceWorker)

    const destinationUrl = `${OUTSIDE_ORIGIN}/destination`
    const { page } = await openSource(context, `<a id="link" href="${destinationUrl}">Result title</a>`, { [destinationUrl]: REDIRECTING_DESTINATION })
    await followSameTabAndDwell(page)
    await page.waitForURL('**/landing')
    await page.waitForTimeout(DWELL_MS)

    expect(await endsOf(serviceWorker)).toEqual([])

    await page.goBack({ waitUntil: 'load' })

    const end = await onlyEnd(serviceWorker)

    expect(end.end_reason).toBe('back')
    expect(end.total_focus_duration_ms).toBeGreaterThanOrEqual(2 * DWELL_MS - 200)
  })

  test('no link_follow or link_follow_end has a field named outcome, used, rejected or satisfied', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const { page } = await openSource(context, SAME_TAB_LINK)
    await followSameTabAndDwell(page)
    await page.goBack({ waitUntil: 'load' })
    await onlyEnd(serviceWorker)

    const records = [...await followsOf(serviceWorker), ...await endsOf(serviceWorker)]
    const judgmentFields = records.flatMap((record) => Object.keys(record).filter((key) => JUDGMENT_FIELDS.includes(key)))

    expect(records.length).toBe(2)
    expect(judgmentFields).toEqual([])
  })

  for (const { name, address } of [
    { name: 'another window', address: 'about:blank' },
    { name: 'the extension\'s own page in its own window', address: undefined },
  ]) {
    test(`focus moving to ${name} stops the destination's count`, async ({ context, serviceWorker }) => {
      await startModule(serviceWorker)

      const { page } = await openSource(context, SAME_TAB_LINK)
      await followSameTabAndDwell(page)
      const otherWindowId = await createWindow(serviceWorker, address)
      await moveFocusToWindow(serviceWorker, otherWindowId)
      await page.waitForTimeout(AWAY_MS)
      await page.goBack({ waitUntil: 'load' })

      const end = await onlyEnd(serviceWorker)

      expect(end.end_reason).toBe('back')
      expect(end.total_focus_duration_ms).toBeGreaterThanOrEqual(800)
      expect(end.total_focus_duration_ms).toBeLessThan(DWELL_MS + AWAY_MS - 200)
    })
  }
})

test.describe('link_follow_end for a destination with no content script (data: URL)', () => {
  const STOPPED_SOURCE = STOPPED_LINK

  async function followToData(page, serviceWorker) {
    await page.click('#link')
    await expect.poll(async () => (await clicksOf(serviceWorker)).length).toBe(1)
    await page.goto(DATA_DESTINATION, { waitUntil: 'load' })
    await page.waitForTimeout(DWELL_MS)
  }

  test('Back ends it', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const { page } = await openSource(context, STOPPED_SOURCE)
    await followToData(page, serviceWorker)
    await page.goBack({ waitUntil: 'load' })

    const end = await onlyEnd(serviceWorker)

    expect(end.end_reason).toBe('back')
    expect(end.destination_url).toBe(DATA_DESTINATION)
    expect(typeof end.shown_at).toBe('number')
    expect(end.total_focus_duration_ms).toBeGreaterThanOrEqual(800)
  })

  test('tab close ends it', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const { page } = await openSource(context, STOPPED_SOURCE)
    await followToData(page, serviceWorker)
    await page.close()

    const end = await onlyEnd(serviceWorker)

    expect(end.end_reason).toBe('tab_closed')
    expect(typeof end.shown_at).toBe('number')
  })

  test('window close ends it', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const { page, windowId } = await openSourceInNewWindow(context, serviceWorker, STOPPED_SOURCE)
    await followToData(page, serviceWorker)
    await removeWindow(serviceWorker, windowId)

    const end = await onlyEnd(serviceWorker)

    expect(end.end_reason).toBe('window_closed')
    expect(typeof end.shown_at).toBe('number')
  })
})

const LATE_CLICK_GAP_MS = 200
const BUSY_AFTER_NAVIGATION_MS = 300
const CLAIMED_BUSY_CROSS_SITE_LINK =
  `<div class="claimable"><a id="link" href="${OUTSIDE_ORIGIN}/destination" onclick="event.preventDefault(); location.href = this.href; const end = Date.now() + ${BUSY_AFTER_NAVIGATION_MS}; while (Date.now() < end) {}">Result title</a></div>`

async function sourceTabOf(serviceWorker, url) {
  await expect.poll(async () => (await eventsOf(serviceWorker, 'load')).filter((event) => event.url === url).length).toBeGreaterThanOrEqual(1)

  return (await eventsOf(serviceWorker, 'load')).find((event) => event.url === url)
}

function lateClickMessage(clickId, sourceUrl, timestamp) {
  return {
    messageType: 'pageClick',
    click_id: clickId,
    url: sourceUrl,
    title: 'Source',
    timestamp,
    click_type: 'primary',
    button: 0,
    modifier_keys: [],
    click_count: 1,
    on_link: true,
    link_url: DESTINATION_URL,
    link_text: 'Result title',
    claim: {},
  }
}

function deliverInOrder(serviceWorker, deliveries, baseMs = undefined) {
  return serviceWorker.evaluate(({ steps, givenBaseMs }) => {
    const plugin = self.rexPageEventsPlugin
    const navigatedAtMs = givenBaseMs ?? Date.now()

    for (const step of steps) {
      if (step.kind === 'navigation') {
        plugin.enqueue(() => plugin.onTabUrlChanged(step.tab.id, step.toUrl, { ...step.tab, url: step.toUrl }))
      } else if (step.kind === 'complete') {
        plugin.enqueue(() => plugin.onTabComplete(step.tab.id, { ...step.tab, url: step.url, status: 'complete' }))
      } else {
        plugin.enqueue(() => plugin.recordClick({ ...step.message, timestamp: navigatedAtMs + step.offsetMs }, { tab: step.tab }))
      }
    }

    return navigatedAtMs
  }, { steps: deliveries, givenBaseMs: baseMs })
}

function completion(tab, url = DESTINATION_URL) {
  return { kind: 'complete', tab, url }
}

function heldNavigationsIn(serviceWorker) {
  return serviceWorker.evaluate(() => self.rexPageEventsPlugin.followState.heldNavigations)
}

function navigation(tab, toUrl = DESTINATION_URL) {
  return { kind: 'navigation', tab, toUrl }
}

function lateClick(tab, clickId, sourceUrl, offsetMs = -LATE_CLICK_GAP_MS) {
  return { kind: 'click', tab, offsetMs, message: lateClickMessage(clickId, sourceUrl, 0) }
}

test.describe('a same-tab navigation that arrives before its click', () => {
  async function openLoadedSource(context, serviceWorker) {
    await startModule(serviceWorker, { ...FOLLOWING_ON, link_follow_match_window: SHORT_WINDOW_MS })

    const { page, url } = await openSource(context, '')
    const load = await sourceTabOf(serviceWorker, url)
    const tab = { id: load.tab_id, windowId: load.window_id, url, title: 'Source', active: true }

    return { page, url, tab }
  }

  test('matches by the click\'s time', async ({ context, serviceWorker }) => {
    const { page, url, tab } = await openLoadedSource(context, serviceWorker)

    await deliverInOrder(serviceWorker, [navigation(tab), lateClick(tab, 'late-click', url)])
    await page.waitForTimeout(PAST_SHORT_WINDOW_MS)

    const follows = await followsOf(serviceWorker)

    expect(follows).toHaveLength(1)
    expect(follows[0]).toMatchObject({ click_id: 'late-click', open_mode: 'same_tab', target_tab_id: tab.id, is_result: true })
  })

  test('is matched once: a second late click does not take the same navigation', async ({ context, serviceWorker }) => {
    const { page, url, tab } = await openLoadedSource(context, serviceWorker)

    await deliverInOrder(serviceWorker, [
      navigation(tab),
      lateClick(tab, 'first-late-click', url),
      lateClick(tab, 'second-late-click', url, -LATE_CLICK_GAP_MS * 2),
    ])
    await page.waitForTimeout(PAST_SHORT_WINDOW_MS)

    const follows = await followsOf(serviceWorker)
    const modeOf = (clickId) => follows.find((follow) => follow.click_id === clickId)?.open_mode

    expect(follows).toHaveLength(2)
    expect(modeOf('first-late-click')).toBe('same_tab')
    expect(modeOf('second-late-click')).toBe('none')
  })

  test('a destination loaded before the late click counts as shown from its load', async ({ context, serviceWorker }) => {
    const { page, url, tab } = await openLoadedSource(context, serviceWorker)
    await page.bringToFront()

    const beforeCompletionMs = Date.now()
    const navigatedAtMs = await deliverInOrder(serviceWorker, [navigation(tab), completion(tab)])
    const afterCompletionMs = Date.now() + LATE_CLICK_GAP_MS
    await page.waitForTimeout(LATE_CLICK_GAP_MS * 3)

    await deliverInOrder(serviceWorker, [lateClick(tab, 'late-click', url)], navigatedAtMs)
    await expect.poll(async () => (await followsOf(serviceWorker)).length).toBe(1)
    await page.waitForTimeout(DWELL_MS)
    await deliverInOrder(serviceWorker, [navigation({ ...tab, url: DESTINATION_URL }, url)])

    await expect.poll(async () => (await endsOf(serviceWorker)).length).toBe(1)

    const [end] = await endsOf(serviceWorker)

    expect(end).toMatchObject({ click_id: 'late-click', end_reason: 'back', before_load: false })
    expect(end.shown_at).toBeGreaterThanOrEqual(beforeCompletionMs)
    expect(end.shown_at).toBeLessThanOrEqual(afterCompletionMs)
    expect(end.total_focus_duration_ms).toBeGreaterThan(DWELL_MS)
  })

  test('the late click and its link_follow carry the source page\'s url_shown_at', async ({ context, serviceWorker }) => {
    const { page, url, tab } = await openLoadedSource(context, serviceWorker)

    await deliverInOrder(serviceWorker, [navigation(tab), lateClick(tab, 'late-click', url)])
    await expect.poll(async () => (await followsOf(serviceWorker)).length).toBe(1)
    await page.waitForTimeout(SETTLE_MS)

    const leavingSource = (await eventsOf(serviceWorker, 'tab_url_change')).find((event) => event.tab_id === tab.id && event.url === url)
    const [click] = (await clicksOf(serviceWorker)).filter((event) => event.click_id === 'late-click')
    const [follow] = await followsOf(serviceWorker)

    expect(leavingSource).toBeDefined()
    expect(click.url_shown_at).toBe(leavingSource.url_shown_at)
    expect(click.url_shown_at).toBeLessThanOrEqual(click.timestamp)
    expect(follow.url_shown_at).toBe(leavingSource.url_shown_at)
  })

  test('a navigation away from a page that is not allowed is not held', async ({ context, serviceWorker }) => {
    await startWithAllowList(serviceWorker)

    const { url } = await openSource(context, '')
    const load = await sourceTabOf(serviceWorker, url)
    const allowedTab = { id: load.tab_id, windowId: load.window_id, url, title: 'Source', active: true }
    const outsideTab = { ...allowedTab, url: `${OUTSIDE_ORIGIN}/page` }

    await deliverInOrder(serviceWorker, [navigation(allowedTab, outsideTab.url)])
    await expect.poll(async () => (await heldNavigationsIn(serviceWorker)).length).toBe(1)

    await deliverInOrder(serviceWorker, [navigation(outsideTab, `${OUTSIDE_ORIGIN}/next`)])
    await serviceWorker.evaluate(() => self.rexPageEventsPlugin.handlerQueue)

    const held = await heldNavigationsIn(serviceWorker)

    expect(held.map((navigation) => navigation.fromUrl)).toEqual([url])
  })

  test('control: a click made after the navigation does not match it', async ({ context, serviceWorker }) => {
    const { page, url, tab } = await openLoadedSource(context, serviceWorker)

    await deliverInOrder(serviceWorker, [navigation(tab), lateClick(tab, 'click-after', url, LATE_CLICK_GAP_MS)])
    await page.waitForTimeout(PAST_SHORT_WINDOW_MS)

    const follows = await followsOf(serviceWorker)

    expect(follows).toHaveLength(1)
    expect(follows[0]).toMatchObject({ click_id: 'click-after', open_mode: 'none' })
  })

  test('control: a navigation away from another page does not match', async ({ context, serviceWorker }) => {
    const { page, tab } = await openLoadedSource(context, serviceWorker)

    await deliverInOrder(serviceWorker, [navigation(tab), lateClick(tab, 'click-elsewhere', `${TEST_ORIGIN}/not-the-source`)])
    await page.waitForTimeout(PAST_SHORT_WINDOW_MS)

    const follows = await followsOf(serviceWorker)

    expect(follows).toHaveLength(1)
    expect(follows[0]).toMatchObject({ click_id: 'click-elsewhere', open_mode: 'none' })
  })

  test('a real page whose navigation commits before its click is sent records same_tab', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const { page, url } = await openSource(context, CLAIMED_BUSY_CROSS_SITE_LINK)
    const load = await sourceTabOf(serviceWorker, url)

    await Promise.all([page.waitForURL(`${OUTSIDE_ORIGIN}/destination`), page.click('#link', { noWaitAfter: true })])
    await expect.poll(async () => (await followsOf(serviceWorker)).length, { timeout: 8000 }).toBe(1)

    const records = await serviceWorker.evaluate(() => self.__capturedEvents)
    const leftSource = records.findIndex((event) => event.event_type === 'tab_url_change' && event.tab_id === load.tab_id && event.url === url)
    const clickRecord = records.findIndex((event) => event.event_type === 'click' && event.tab_id === load.tab_id)
    const [click] = await clicksOf(serviceWorker)
    const [follow] = await followsOf(serviceWorker)

    expect(leftSource).toBeGreaterThanOrEqual(0)
    expect(clickRecord).toBeGreaterThan(leftSource)
    expect(follow).toMatchObject({ click_id: click.click_id, open_mode: 'same_tab', target_tab_id: load.tab_id, is_result: true })
  })
})

const totalsOf = (serviceWorker) => serviceWorker.evaluate(() => new Promise((resolve) => {
  self.rexCorePlugin.handleMessage({ messageType: 'linkFollowTotals' }, null, (response) => resolve(response))
}))

test.describe('linkFollowTotals', () => {
  test('reports an open follow\'s rising milliseconds and shown', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const { page } = await openSource(context, NEW_TAB_LINK)
    const [destination] = await Promise.all([context.waitForEvent('page'), page.click('#link')])
    await destination.waitForLoadState('load')
    await destination.waitForTimeout(DWELL_MS)

    const [follow] = await followsOf(serviceWorker)
    const [first] = await totalsOf(serviceWorker)
    await destination.waitForTimeout(DWELL_MS)
    const [second] = await totalsOf(serviceWorker)

    expect(first).toEqual({ click_id: follow.click_id, shown: true, total_focus_duration_ms: expect.any(Number) })
    expect(first.total_focus_duration_ms).toBeGreaterThan(0)
    expect(second.total_focus_duration_ms).toBeGreaterThan(first.total_focus_duration_ms + DWELL_MS / 2)
  })

  test('a destination still loading reports shown false and 0 ms', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const { page } = await openSource(context, '<a id="link" href="/held" target="_blank">Result title</a>', { [HELD_URL]: HELD })
    await page.click('#link')
    await expect.poll(async () => (await followsOf(serviceWorker)).length).toBe(1)
    await page.waitForTimeout(DWELL_MS)

    const [follow] = await followsOf(serviceWorker)

    expect(await totalsOf(serviceWorker)).toEqual([{ click_id: follow.click_id, shown: false, total_focus_duration_ms: 0 }])
  })

  test('control: an ended follow and a quiet module report nothing', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    expect(await totalsOf(serviceWorker)).toEqual([])

    const { page } = await openSource(context, NEW_TAB_LINK)
    const [destination] = await Promise.all([context.waitForEvent('page'), page.click('#link')])
    await destination.waitForLoadState('load')
    await destination.close()
    await onlyEnd(serviceWorker)

    expect(await totalsOf(serviceWorker)).toEqual([])
  })
})
