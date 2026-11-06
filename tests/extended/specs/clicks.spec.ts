// @ts-nocheck

import { test, expect, BASE_CONFIG, loadConfig, waitForPageEventsConfig, resetCaptured } from './fixtures.js'

const TEST_ORIGIN = 'https://pages.test'
const SETTLE_MS = 1000
const PAGE_READY_MS = 1000
const LINK_TEXT_LIMIT = 200

let pageCount = 0

async function startModule(serviceWorker, pageEvents = { allow_all: true }) {
  const config = { ...BASE_CONFIG, page_events: { enabled: true, ...pageEvents } }

  await loadConfig(serviceWorker, config)
  await waitForPageEventsConfig(serviceWorker)
  await resetCaptured(serviceWorker)
}

async function openTestPage(context, body, origin = TEST_ORIGIN) {
  pageCount += 1

  const url = `${origin}/click-page-${pageCount}`
  const html = `<!doctype html><html><head><title>Click page ${pageCount}</title></head><body>${body}</body></html>`
  const page = await context.newPage()

  await page.route('**/*', async (route) => {
    const requestUrl = new URL(route.request().url())

    if (requestUrl.origin !== origin) {
      return route.abort()
    }

    const pageHtml = requestUrl.href === url ? html : '<!doctype html><title>Next</title><p>Next</p>'

    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: pageHtml })
  })

  await page.goto(url, { waitUntil: 'load' })
  await page.waitForTimeout(PAGE_READY_MS)

  return { page, url }
}

async function clicksOf(serviceWorker) {
  return serviceWorker.evaluate(() => self.__capturedEvents.filter((event) => event.event_type === 'click'))
}

async function settledClicks(page, serviceWorker) {
  await page.waitForTimeout(SETTLE_MS)

  return clicksOf(serviceWorker)
}

const LINK = '<a id="link" href="/destination" target="_blank">Result title</a>'
const BLANK_SPACE = '<div id="blank" style="width: 300px; height: 300px">Nothing here</div>'

test.describe('click records', () => {
  test('a primary click on a link records one click with its link metadata', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const { page, url } = await openTestPage(context, LINK)
    await page.click('#link')

    const clicks = await settledClicks(page, serviceWorker)

    expect(clicks.length).toBe(1)
    expect(clicks[0]).toMatchObject({
      name: 'rex-page-event',
      url,
      click_type: 'primary',
      button: 0,
      click_count: 1,
      modifier_keys: [],
      on_link: true,
      link_url: `${TEST_ORIGIN}/destination`,
      link_text: 'Result title',
      link_target: '_blank',
    })
    expect(typeof clicks[0].click_id).toBe('string')
    expect(clicks[0].click_id.length).toBeGreaterThan(0)
    expect(Number.isInteger(clicks[0].timestamp)).toBe(true)
    expect(typeof clicks[0].session_id).toBe('string')
    expect(Number.isInteger(clicks[0].tab_id)).toBe(true)
  })

  test('a click on blank space records on_link false and no link fields', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const { page } = await openTestPage(context, BLANK_SPACE)
    await page.click('#blank')

    const clicks = await settledClicks(page, serviceWorker)

    expect(clicks.length).toBe(1)
    expect(clicks[0].on_link).toBe(false)
    expect('link_url' in clicks[0]).toBe(false)
    expect('link_text' in clicks[0]).toBe(false)
    expect('link_target' in clicks[0]).toBe(false)
  })

  test('a link without a target records no link_target', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const { page } = await openTestPage(context, '<a id="plain" href="/destination">Plain</a>')
    await page.click('#plain')

    const clicks = await settledClicks(page, serviceWorker)

    expect(clicks.length).toBe(1)
    expect('link_target' in clicks[0]).toBe(false)
  })

  test('a click on a link with a malformed address still records one click', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const { page } = await openTestPage(context, '<a id="bad" href="http://">Broken</a>')
    await page.click('#bad')

    const clicks = await settledClicks(page, serviceWorker)

    expect(clicks.length).toBe(1)
    expect(clicks[0].on_link).toBe(true)
    expect(clicks[0].link_text).toBe('Broken')
  })

  test('a click on a page served over http records a click_id', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const { page } = await openTestPage(context, LINK, 'http://pages.test')
    await page.click('#link')

    const clicks = await settledClicks(page, serviceWorker)

    expect(clicks.length).toBe(1)
    expect(typeof clicks[0].click_id).toBe('string')
    expect(clicks[0].click_id).toMatch(/^[0-9a-f-]{36}$/)
  })

  test('a middle click records click_type middle once', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const { page } = await openTestPage(context, LINK)
    await page.click('#link', { button: 'middle' })

    const clicks = await settledClicks(page, serviceWorker)

    expect(clicks.length).toBe(1)
    expect(clicks[0].click_type).toBe('middle')
    expect(clicks[0].button).toBe(1)
  })

  test('a right click records click_type right once', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const { page } = await openTestPage(context, LINK)
    await page.click('#link', { button: 'right' })

    const clicks = await settledClicks(page, serviceWorker)

    expect(clicks.length).toBe(1)
    expect(clicks[0].click_type).toBe('right')
    expect(clicks[0].button).toBe(2)
  })

  test('a Control-click fired as contextmenu with button 0 records right with control', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const { page } = await openTestPage(context, LINK)
    await page.evaluate(() => {
      document.querySelector('#link').dispatchEvent(new MouseEvent('contextmenu', { button: 0, ctrlKey: true, bubbles: true }))
    })

    const clicks = await settledClicks(page, serviceWorker)

    expect(clicks.length).toBe(1)
    expect(clicks[0].click_type).toBe('right')
    expect(clicks[0].button).toBe(0)
    expect(clicks[0].modifier_keys).toEqual(['control'])
  })

  test('a right click followed by auxclick with button 2 records one click', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const { page } = await openTestPage(context, LINK)
    await page.dispatchEvent('#link', 'contextmenu', { button: 2, bubbles: true })
    await page.dispatchEvent('#link', 'auxclick', { button: 2, bubbles: true })

    const clicks = await settledClicks(page, serviceWorker)

    expect(clicks.length).toBe(1)
    expect(clicks[0].click_type).toBe('right')
  })

  test('a mouse back button records other with button 3', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const { page } = await openTestPage(context, LINK)
    await page.dispatchEvent('#link', 'auxclick', { button: 3, bubbles: true })

    const clicks = await settledClicks(page, serviceWorker)

    expect(clicks.length).toBe(1)
    expect(clicks[0].click_type).toBe('other')
    expect(clicks[0].button).toBe(3)
  })

  test('held keys are listed in modifier_keys', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const { page } = await openTestPage(context, BLANK_SPACE)
    await page.click('#blank', { modifiers: ['Shift', 'Meta'] })

    const clicks = await settledClicks(page, serviceWorker)

    expect(clicks.length).toBe(1)
    expect([...clicks[0].modifier_keys].sort()).toEqual(['meta', 'shift'])
  })

  test('link_text is one trimmed line of at most 200 characters', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const longWord = 'x'.repeat(300)
    const body = `<a id="rich" href="/destination">\n  <span>First\n line</span>\n  <span> second </span>\n  ${longWord}\n</a>`
    const { page } = await openTestPage(context, body)

    await page.click('#rich')

    const clicks = await settledClicks(page, serviceWorker)

    expect(clicks.length).toBe(1)
    expect(clicks[0].link_text).toBe(`First line second ${'x'.repeat(LINK_TEXT_LIMIT - 'First line second '.length)}`)
    expect(clicks[0].link_text.length).toBe(LINK_TEXT_LIMIT)
    expect(clicks[0].link_text).not.toMatch(/[\r\n\t]/)
  })

  test('link_text of a short multi-line link is collapsed and trimmed', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const { page } = await openTestPage(context, '<a id="rich" href="/destination">\n  <b>Two</b>\n\n  <i>words</i>\n</a>')

    await page.click('#rich')

    const clicks = await settledClicks(page, serviceWorker)

    expect(clicks[0].link_text).toBe('Two words')
  })

  test('on a page that is not allowed, url and link_url are hidden', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker, {})

    const { page } = await openTestPage(context, LINK)
    await page.click('#link')

    const clicks = await settledClicks(page, serviceWorker)

    expect(clicks.length).toBe(1)
    expect(clicks[0].url).toBe('CATEGORY:NOT_ON_ALLOWLIST')
    expect(clicks[0].link_url).toBe('CATEGORY:NOT_ON_ALLOWLIST')
    expect('title' in clicks[0]).toBe(false)
    expect('link_text' in clicks[0]).toBe(false)
  })

  test('event_types.click false records no click', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker, { allow_all: true, event_types: { click: false } })

    const { page } = await openTestPage(context, LINK)
    await page.click('#link')

    expect(await settledClicks(page, serviceWorker)).toEqual([])
  })

  test('event_types.click true records the click the same page produces', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker, { allow_all: true, event_types: { click: true } })

    const { page } = await openTestPage(context, LINK)
    await page.click('#link')

    expect((await settledClicks(page, serviceWorker)).length).toBe(1)
  })

  test.describe('click IDs and claims', () => {
    const CLAIMED_DESTINATION = 'https://claimed.test/destination'
    const CLAIMABLE_LINK = '<div class="claimable"><a id="link" href="/destination">Result title</a></div>'

    test('two callers of clickIdFor get the same ID for one click, and the click record carries it', async ({ context, serviceWorker }) => {
      await startModule(serviceWorker)

      const { page } = await openTestPage(context, `<div class="claimable"><a id="link" href="/destination" target="_blank">Result title</a></div>`)
      await page.click('#link')

      const clicks = await settledClicks(page, serviceWorker)
      const seenIds = (await page.getAttribute('#link', 'data-click-ids')).split(' ')

      expect(clicks.length).toBe(1)
      expect(seenIds.length).toBe(2)
      expect(seenIds[0]).toBe(seenIds[1])
      expect(clicks[0].click_id).toBe(seenIds[0])
    })

    test('two quick clicks get different IDs', async ({ context, serviceWorker }) => {
      await startModule(serviceWorker)

      const { page } = await openTestPage(context, BLANK_SPACE)
      await page.click('#blank', { clickCount: 2, delay: 10 })

      const clicks = await settledClicks(page, serviceWorker)

      expect(clicks.length).toBe(2)
      expect(clicks[0].click_id).not.toBe(clicks[1].click_id)
    })

    test('a claim made in a document capture listener rides on the click record', async ({ context, serviceWorker }) => {
      await startModule(serviceWorker)

      const { page } = await openTestPage(context, CLAIMABLE_LINK.replace('/destination"', '/destination" target="_blank"'))
      await page.click('#link')

      const clicks = await settledClicks(page, serviceWorker)

      expect(clicks.length).toBe(1)
      expect(clicks[0].claim).toEqual({ destination_url: CLAIMED_DESTINATION })
    })

    test('a click outside a claimable area carries no claim', async ({ context, serviceWorker }) => {
      await startModule(serviceWorker)

      const { page } = await openTestPage(context, LINK)
      await page.click('#link')

      const clicks = await settledClicks(page, serviceWorker)

      expect(clicks.length).toBe(1)
      expect('claim' in clicks[0]).toBe(false)
    })

    test('a claim made on a link that navigates in the same tab is still recorded', async ({ context, serviceWorker }) => {
      await startModule(serviceWorker)

      const { page } = await openTestPage(context, CLAIMABLE_LINK)
      await Promise.all([page.waitForURL('**/destination'), page.click('#link')])

      const clicks = await clicksOf(serviceWorker)

      expect(clicks.length).toBe(1)
      expect(clicks[0].claim).toEqual({ destination_url: CLAIMED_DESTINATION })
    })

    test('a page that stops propagation in the bubble phase still records the click once, with its claim', async ({ context, serviceWorker }) => {
      await startModule(serviceWorker)

      const { page } = await openTestPage(context, CLAIMABLE_LINK.replace('/destination"', '/destination" target="_blank"'))
      await page.evaluate(() => {
        document.querySelector('#link').addEventListener('click', (event) => event.stopPropagation())
      })
      await page.click('#link')

      const clicks = await settledClicks(page, serviceWorker)

      expect(clicks.length).toBe(1)
      expect(clicks[0].claim).toEqual({ destination_url: CLAIMED_DESTINATION })
    })
  })
})
