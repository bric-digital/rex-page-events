// @ts-nocheck

import { test, expect, BASE_CONFIG, loadConfig, waitForPageEventsConfig, resetCaptured } from './fixtures.js'

const TEST_ORIGIN = 'https://pages.test'
const PAGE_READY_MS = 1000
const DWELL_MS = 1000
const SETTLE_MS = 1000
const NEXT_PAGE = '<!doctype html><title>Next</title><p>Next</p>'
const HELD = Symbol('held')
const LINK_TEXT = 'Result title'

const RESULT_DESTINATION = 'https://www.result.test/page?q=1#part'
const RESULT_ORIGIN = 'https://www.result.test'

let pageCount = 0

function pageHtml(title, body = '') {
  return `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`
}

function redirectLinkTo(destination) {
  return `${TEST_ORIGIN}/goto?url=${encodeURIComponent(destination)}`
}

function claimedLink(destination, { href = destination, target = '' } = {}) {
  return `<div class="claimable" data-claim-destination="${destination}"><a id="link" href="${href}"${target}>${LINK_TEXT}</a></div>`
}

function claimedRedirectLink(destination, target = '') {
  return claimedLink(destination, { href: redirectLinkTo(destination), target })
}

function unclaimedLink(destination) {
  return `<a id="link" href="${destination}">${LINK_TEXT}</a>`
}

async function addListEntry(serviceWorker, listName, host, category) {
  await serviceWorker.evaluate(async ({ listName, host, category }) => {
    await self.createListEntry({ list_name: listName, pattern: host, pattern_type: 'host', source: 'backend', metadata: { category } })
  }, { listName, host, category })
}

async function startModule(serviceWorker, { linkFollow = true, hiddenLinkMode } = {}) {
  await addListEntry(serviceWorker, 'address-allow', 'pages.test', 'ALLOWED')
  await addListEntry(serviceWorker, 'address-allow', 'kept.test', 'ALLOWED')
  await addListEntry(serviceWorker, 'address-filter', 'filtered.test', 'TEST_FILTERED')
  await addListEntry(serviceWorker, 'address-domain-only', 'domain-only.test', 'TEST_DOMAIN')

  const pageEvents = {
    enabled: true,
    allow_lists: ['address-allow'],
    filter_lists: ['address-filter'],
    domain_only_lists: ['address-domain-only'],
    event_types: { link_follow: linkFollow },
  }

  if (hiddenLinkMode !== undefined) {
    pageEvents.hidden_link_mode = hiddenLinkMode
  }

  await loadConfig(serviceWorker, { ...BASE_CONFIG, page_events: pageEvents })
  await waitForPageEventsConfig(serviceWorker)
  await resetCaptured(serviceWorker)
}

async function serveSite(context) {
  await context.route('**/*', async (route) => {
    const requestUrl = new URL(route.request().url())

    if (!requestUrl.hostname.endsWith('.test')) {
      return route.abort()
    }

    if (requestUrl.origin === TEST_ORIGIN && requestUrl.pathname === '/goto') {
      return undefined
    }

    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: NEXT_PAGE })
  })
}

async function openSource(context, body) {
  pageCount += 1

  const url = `${TEST_ORIGIN}/source-${pageCount}`

  await serveSite(context)
  await context.route(url, (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: pageHtml(`Source ${pageCount}`, body) }))

  const page = await context.newPage()

  await page.goto(url, { waitUntil: 'load' })
  await page.waitForTimeout(PAGE_READY_MS)

  return { page, url }
}

function eventsOf(serviceWorker, eventType) {
  return serviceWorker.evaluate((type) => self.__capturedEvents.filter((event) => event.event_type === type), eventType)
}

function allRecordsText(serviceWorker) {
  return serviceWorker.evaluate(() => JSON.stringify(self.__capturedEvents))
}

async function followAndReturn(page, destination) {
  const destinationHost = new URL(destination).host

  await Promise.all([page.waitForURL((address) => address.host === destinationHost), page.click('#link')])
  await page.waitForLoadState('load')
  await page.waitForTimeout(DWELL_MS)
  await page.goBack({ waitUntil: 'load' })
}

async function clickAndEnd(serviceWorker) {
  await expect.poll(async () => (await eventsOf(serviceWorker, 'link_follow_end')).length).toBe(1)

  const [click] = await eventsOf(serviceWorker, 'click')
  const [end] = await eventsOf(serviceWorker, 'link_follow_end')

  return { click, end }
}

async function clickOnly(page, serviceWorker) {
  await page.click('#link')
  await page.waitForTimeout(SETTLE_MS)
  await expect.poll(async () => (await eventsOf(serviceWorker, 'click')).length).toBe(1)

  const [click] = await eventsOf(serviceWorker, 'click')

  return click
}

const CLAIMED_LIST_CASES = [
  { name: 'off the allow list keeps its origin', destination: RESULT_DESTINATION, kept: RESULT_ORIGIN },
  { name: 'on a filter list and off the allow list is its category', destination: 'https://filtered.test/page?q=1', kept: 'CATEGORY:TEST_FILTERED' },
  { name: 'on a domain-only list is its hostname', destination: 'https://domain-only.test/page?q=1', kept: 'domain-only.test' },
  { name: 'on the allow list is kept in full', destination: 'https://kept.test/page?q=1', kept: 'https://kept.test/page?q=1' },
]

test.describe('a claimed click under show, the default while link following is on', () => {
  for (const { name, destination, kept } of CLAIMED_LIST_CASES) {
    test(`a claimed destination ${name}, in link_url and destination_url`, async ({ context, serviceWorker }) => {
      await startModule(serviceWorker)

      const { page } = await openSource(context, claimedLink(destination))
      await followAndReturn(page, destination)

      const { click, end } = await clickAndEnd(serviceWorker)

      expect(click.claimed).toBe(true)
      expect(click.link_url).toBe(kept)
      expect(click.link_text).toBe(LINK_TEXT)
      expect(end.destination_url).toBe(kept)
    })
  }

  test('control: an unclaimed follow off the allow list keeps neither address, and keeps its text', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const { page } = await openSource(context, unclaimedLink(RESULT_DESTINATION))
    await followAndReturn(page, RESULT_DESTINATION)

    const { click, end } = await clickAndEnd(serviceWorker)

    expect('claimed' in click).toBe(false)
    expect(click.link_url).toBe('CATEGORY:NOT_ON_ALLOWLIST')
    expect(click.link_text).toBe(LINK_TEXT)
    expect(end.destination_url).toBe('CATEGORY:NOT_ON_ALLOWLIST')
  })

  test('an invalid hidden_link_mode uses show', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker, { hiddenLinkMode: 'bogus' })

    const { page } = await openSource(context, claimedLink(RESULT_DESTINATION))
    await followAndReturn(page, RESULT_DESTINATION)

    const { click, end } = await clickAndEnd(serviceWorker)

    expect(click.link_url).toBe(RESULT_ORIGIN)
    expect(end.destination_url).toBe(RESULT_ORIGIN)
  })
})

test.describe('a redirect link', () => {
  test('a claim\'s destination_url replaces a redirect link\'s address, and no record holds the redirect', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const { page } = await openSource(context, claimedRedirectLink(RESULT_DESTINATION, ' target="_blank"'))
    await page.click('#link')
    await expect.poll(async () => (await eventsOf(serviceWorker, 'link_follow')).length).toBe(1)
    await page.waitForTimeout(DWELL_MS)

    const [follow] = await eventsOf(serviceWorker, 'link_follow')
    await serviceWorker.evaluate((tabId) => chrome.tabs.remove(tabId), follow.target_tab_id)

    const { click, end } = await clickAndEnd(serviceWorker)

    expect(click.link_url).toBe(RESULT_ORIGIN)
    expect(end.before_load).toBe(true)
    expect(end.destination_url).toBe(RESULT_ORIGIN)
    expect(await allRecordsText(serviceWorker)).not.toContain('/goto?')
  })
})

test.describe('modes with no exception', () => {
  test('under text_only a claimed click keeps neither address, and keeps its text', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker, { hiddenLinkMode: 'text_only' })

    const { page } = await openSource(context, claimedLink(RESULT_DESTINATION))
    await followAndReturn(page, RESULT_DESTINATION)

    const { click, end } = await clickAndEnd(serviceWorker)

    expect(click.link_url).toBe('CATEGORY:NOT_ON_ALLOWLIST')
    expect(click.link_text).toBe(LINK_TEXT)
    expect(end.destination_url).toBe('CATEGORY:NOT_ON_ALLOWLIST')
  })

  test('under hide a claimed click keeps neither address nor its text', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker, { hiddenLinkMode: 'hide' })

    const { page } = await openSource(context, claimedLink(RESULT_DESTINATION))
    await followAndReturn(page, RESULT_DESTINATION)

    const { click, end } = await clickAndEnd(serviceWorker)

    expect(click.link_url).toBe('CATEGORY:NOT_ON_ALLOWLIST')
    expect('link_text' in click).toBe(false)
    expect(end.destination_url).toBe('CATEGORY:NOT_ON_ALLOWLIST')
  })
})

test.describe('with link following off', () => {
  test('a claimed click\'s link_url stays hidden under the default mode', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker, { linkFollow: false })

    const { page } = await openSource(context, claimedRedirectLink(RESULT_DESTINATION, ' target="_blank"'))
    const click = await clickOnly(page, serviceWorker)

    expect(click.claimed).toBe(true)
    expect(click.link_url).toBe('CATEGORY:NOT_ON_ALLOWLIST')
    expect(click.link_text).toBe(LINK_TEXT)
  })

  test('a claimed click keeps its destination\'s origin when show is configured', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker, { linkFollow: false, hiddenLinkMode: 'show' })

    const { page } = await openSource(context, claimedRedirectLink(RESULT_DESTINATION, ' target="_blank"'))
    const click = await clickOnly(page, serviceWorker)

    expect(click.link_url).toBe(RESULT_ORIGIN)
  })
})
