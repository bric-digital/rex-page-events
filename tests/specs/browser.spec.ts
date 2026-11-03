// @ts-nocheck

import { test, expect, BASE_CONFIG, loadConfig, waitForPageEventsConfig, resetCaptured } from './fixtures.js'

const TEST_ORIGIN = 'https://pages.test'
const HELD_IMAGE_PATH = '/held.png'
const SETTLE_MS = 2000

let pageCount = 0

async function startModule(serviceWorker, config = BASE_CONFIG) {
  await loadConfig(serviceWorker, config)
  await waitForPageEventsConfig(serviceWorker)
  await resetCaptured(serviceWorker)
}

async function openTestPage(context, body, options = {}) {
  pageCount += 1

  const url = `${TEST_ORIGIN}/page-${pageCount}`
  const image = options.holdImage === true ? `<img src="${HELD_IMAGE_PATH}">` : ''
  const html = `<!doctype html><html><head><title>Test page ${pageCount}</title></head><body>${body}${image}</body></html>`

  let releaseImage = () => {}
  const imageReleased = new Promise((resolve) => {
    releaseImage = resolve
  })

  const page = await context.newPage()

  await page.route('**/*', async (route) => {
    const requestUrl = new URL(route.request().url())

    if (requestUrl.origin !== TEST_ORIGIN) {
      return route.abort()
    }

    if (requestUrl.pathname === HELD_IMAGE_PATH) {
      await imageReleased

      return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg"/>' })
    }

    const pageHtml = requestUrl.href === url ? html : '<!doctype html><title>Next</title><p>Next</p>'

    return route.fulfill({ contentType: 'text/html; charset=utf-8', body: pageHtml })
  })

  await page.goto(url, { waitUntil: 'commit' })

  return { page, url, releaseImage }
}

async function loadStartOf(page) {
  return page.evaluate(() => {
    const [navigation] = performance.getEntriesByType('navigation')

    return performance.timeOrigin + navigation.loadEventStart
  })
}

async function pageEventsOf(serviceWorker, eventType) {
  return serviceWorker.evaluate((type) => {
    return self.__capturedEvents.filter((event) => event.event_type === type)
  }, eventType)
}

const TALL_PAGE = '<div style="height: 5000px">Tall page</div>'
const WIDE_PAGE = '<div style="width: 5000px">Wide page</div>'

async function capturedEvents(serviceWorker) {
  return serviceWorker.evaluate(() => self.__capturedEvents)
}

async function scrollsOf(serviceWorker, url) {
  return (await pageEventsOf(serviceWorker, 'scroll')).filter((event) => event.url === url)
}

async function positionOf(page) {
  return page.evaluate(() => ({
    top: window.scrollY,
    left: window.scrollX,
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight,
    document_height: document.documentElement.scrollHeight,
    document_width: document.documentElement.scrollWidth,
  }))
}

test.describe('REX Page Events in pages', () => {
  test('leaving a page the browser does not cache records page_hide with persisted false', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const { page, url } = await openTestPage(context, '<p>First page</p>')

    await page.waitForTimeout(SETTLE_MS)
    await page.goto(`${TEST_ORIGIN}/next`)

    await expect.poll(async () => {
      const hides = await pageEventsOf(serviceWorker, 'page_hide')

      return hides.filter((event) => event.url === url).map((event) => event.persisted)
    }, { timeout: 5000 }).toEqual([false])
  })

  test('a page already loaded when the browser part arrives records one load at its load time', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const { page, url } = await openTestPage(context, '<p>Loads at once</p>')

    await page.waitForTimeout(SETTLE_MS)

    const loads = (await pageEventsOf(serviceWorker, 'load')).filter((event) => event.url === url)

    expect(loads.length).toBe(1)
    expect(Number.isInteger(loads[0].date)).toBe(true)
    expect(Math.abs(loads[0].date - await loadStartOf(page))).toBeLessThanOrEqual(5)

    const [start] = await scrollsOf(serviceWorker, url)

    expect(start.date).toBeGreaterThan(loads[0].date)
  })

  test('a page still loading when the browser part arrives records load when it finishes', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const { page, url, releaseImage } = await openTestPage(context, '<p>Waits for an image</p>', { holdImage: true })

    await page.waitForTimeout(SETTLE_MS)

    expect(await pageEventsOf(serviceWorker, 'load')).toEqual([])

    releaseImage()

    await expect.poll(async () => {
      const loads = await pageEventsOf(serviceWorker, 'load')

      return loads.filter((event) => event.url === url).length
    }, { timeout: 5000 }).toBe(1)

    const [load] = (await pageEventsOf(serviceWorker, 'load')).filter((event) => event.url === url)

    expect(Number.isInteger(load.date)).toBe(true)
    expect(Math.abs(load.date - await loadStartOf(page))).toBeLessThanOrEqual(5)

    const [start] = await scrollsOf(serviceWorker, url)

    expect(start.date).toBeLessThan(load.date)
  })

  test('a page left before it finishes loading, and not cached, records no load', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const { page, url } = await openTestPage(context, '<p>Left while loading</p>', { holdImage: true })

    await page.waitForTimeout(SETTLE_MS)
    await page.goto(`${TEST_ORIGIN}/next`)

    await expect.poll(async () => {
      const hides = await pageEventsOf(serviceWorker, 'page_hide')

      return hides.filter((event) => event.url === url).map((event) => event.persisted)
    }, { timeout: 5000 }).toEqual([false])

    const loads = (await pageEventsOf(serviceWorker, 'load')).filter((event) => event.url === url)

    expect(loads).toEqual([])
  })

  test('a same-document navigation records no second load', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const { page } = await openTestPage(context, '<p>Changes its address</p>')

    await page.waitForTimeout(SETTLE_MS)
    await page.evaluate(() => {
      history.pushState({}, '', '/same-document')
    })
    await page.waitForTimeout(1000)

    expect((await pageEventsOf(serviceWorker, 'load')).length).toBe(1)
  })

  test('the starting scroll position is recorded', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const { page, url } = await openTestPage(context, TALL_PAGE)

    await page.waitForTimeout(SETTLE_MS)

    const scrolls = await scrollsOf(serviceWorker, url)

    expect(scrolls.length).toBe(1)
    expect(scrolls[0].scroll_position).toEqual(await positionOf(page))
    expect(scrolls[0].scroll_position.top).toBe(0)
  })

  test('scrolling records one position per pause and none while it continues', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const { page, url } = await openTestPage(context, TALL_PAGE)

    await page.waitForTimeout(SETTLE_MS)
    await page.mouse.move(200, 200)

    for (let step = 0; step < 10; step += 1) {
      await page.mouse.wheel(0, 100)
      await page.waitForTimeout(100)
    }

    expect((await scrollsOf(serviceWorker, url)).length).toBe(1)

    await page.waitForTimeout(500)

    const scrolls = await scrollsOf(serviceWorker, url)

    expect(scrolls.length).toBe(2)
    expect(scrolls[1].scroll_position.top).toBe((await positionOf(page)).top)
    expect(scrolls[1].scroll_position.top).toBeGreaterThan(0)
  })

  test('a configured scroll pause delays the record until scrolling has paused that long', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker, { ...BASE_CONFIG, page_events: { enabled: true, scroll_pause_delay: 1000 } })

    const { page, url } = await openTestPage(context, TALL_PAGE)

    await page.waitForTimeout(SETTLE_MS)
    await page.mouse.move(200, 200)

    for (let step = 0; step < 10; step += 1) {
      await page.mouse.wheel(0, 100)
      await page.waitForTimeout(100)
    }

    await page.waitForTimeout(500)

    expect((await scrollsOf(serviceWorker, url)).length).toBe(1)

    await page.waitForTimeout(800)

    const scrolls = await scrollsOf(serviceWorker, url)

    expect(scrolls.length).toBe(2)
    expect(scrolls[1].scroll_position.top).toBe((await positionOf(page)).top)
  })

  test('a scroll pause that is not a number uses 250 ms', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker, { ...BASE_CONFIG, page_events: { enabled: true, scroll_pause_delay: '1000' } })

    const { page, url } = await openTestPage(context, TALL_PAGE)

    await page.waitForTimeout(SETTLE_MS)
    await page.mouse.move(200, 200)

    for (let step = 0; step < 10; step += 1) {
      await page.mouse.wheel(0, 100)
      await page.waitForTimeout(100)
    }

    await page.waitForTimeout(500)

    expect((await scrollsOf(serviceWorker, url)).length).toBe(2)
  })

  test('leaving the page during a pause records the position at once (D60)', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const { page, url } = await openTestPage(context, TALL_PAGE)

    await page.waitForTimeout(SETTLE_MS)
    await page.evaluate(() => {
      window.scrollTo(0, 1200)
    })
    await page.goto(`${TEST_ORIGIN}/next`)

    await expect.poll(async () => {
      const scrolls = await scrollsOf(serviceWorker, url)

      return scrolls.map((event) => event.scroll_position.top)
    }, { timeout: 5000 }).toEqual([0, 1200])

    const events = await capturedEvents(serviceWorker)
    const leftAt = events.findIndex((event) => event.event_type === 'page_hide' && event.url === url)
    const lastScrollAt = events.findLastIndex((event) => event.event_type === 'scroll' && event.url === url)

    expect(leftAt).toBeGreaterThan(lastScrollAt)
  })

  test('closing the tab during a pause records the position, then page_hide, then tab_close', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const { page, url } = await openTestPage(context, TALL_PAGE)

    await page.waitForTimeout(SETTLE_MS)
    await page.evaluate(() => {
      window.scrollTo(0, 1200)
    })
    await page.close()

    await expect.poll(async () => {
      const events = await capturedEvents(serviceWorker)

      return events
        .filter((event) => event.url === url && ['scroll', 'page_hide', 'tab_close'].includes(event.event_type))
        .map((event) => event.event_type === 'scroll' ? `scroll ${event.scroll_position.top}` : `${event.event_type} ${event.persisted ?? ''}`.trim())
    }, { timeout: 5000 }).toEqual(['scroll 0', 'scroll 1200', 'page_hide false', 'tab_close'])
  })

  test('a page too short to scroll records only its starting position', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const { page, url } = await openTestPage(context, '<p>Short page</p>')

    await page.waitForTimeout(SETTLE_MS)
    await page.mouse.move(200, 200)
    await page.mouse.wheel(0, 500)
    await page.waitForTimeout(500)

    const scrolls = await scrollsOf(serviceWorker, url)

    expect(scrolls.length).toBe(1)
    expect(scrolls[0].scroll_position.document_height).toBeLessThanOrEqual(scrolls[0].scroll_position.height)
  })

  test('scrolling a wide page sideways records its position and full width', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const { page, url } = await openTestPage(context, WIDE_PAGE)

    await page.waitForTimeout(SETTLE_MS)
    await page.evaluate(() => {
      window.scrollTo(800, 0)
    })
    await page.waitForTimeout(500)

    const scrolls = await scrollsOf(serviceWorker, url)

    expect(scrolls.length).toBe(2)
    expect(scrolls[1].scroll_position).toEqual(await positionOf(page))
    expect(scrolls[1].scroll_position.left).toBe(800)
    expect(scrolls[1].scroll_position.document_width).toBeGreaterThan(scrolls[1].scroll_position.width)
  })

  test('scrolling inside a box records nothing', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const box = '<div id="box" style="height: 300px; overflow: auto"><div style="height: 3000px">Inside the box</div></div>'
    const { page, url } = await openTestPage(context, box)

    await page.waitForTimeout(SETTLE_MS)
    await page.evaluate(() => {
      document.getElementById('box').scrollTop = 1000
    })
    await page.waitForTimeout(500)

    expect(await page.evaluate(() => document.getElementById('box').scrollTop)).toBe(1000)
    expect((await scrollsOf(serviceWorker, url)).length).toBe(1)
  })
})

test.describe('REX Page Events in pages the browser caches', () => {
  test.use({ backForwardCache: true })

  test('leaving a page the browser caches records page_hide with persisted true', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const { page, url } = await openTestPage(context, '<p>Cached page</p>')

    await page.waitForTimeout(SETTLE_MS)
    await page.goto(`${TEST_ORIGIN}/next`)

    await expect.poll(async () => {
      const hides = await pageEventsOf(serviceWorker, 'page_hide')

      return hides.filter((event) => event.url === url).map((event) => event.persisted)
    }, { timeout: 5000 }).toEqual([true])
  })

  test('a return from the back/forward cache records the restored position and no second load', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const { page, url } = await openTestPage(context, TALL_PAGE)

    await page.waitForTimeout(SETTLE_MS)
    await page.evaluate(() => {
      window.scrollTo(0, 800)
    })
    await page.waitForTimeout(500)
    await page.goto(`${TEST_ORIGIN}/next`)
    await page.waitForTimeout(500)
    await page.evaluate(() => {
      history.back()
    })
    await page.waitForTimeout(1000)

    const events = (await capturedEvents(serviceWorker)).filter((event) => event.url === url)
    const cachedAt = events.findIndex((event) => event.event_type === 'page_hide' && event.persisted === true)

    expect(events.some((event) => event.event_type === 'page_show' && event.persisted === true)).toBe(true)

    const scrollsAfter = events.slice(cachedAt).filter((event) => event.event_type === 'scroll')

    expect(scrollsAfter.map((event) => event.scroll_position.top)).toEqual([800])
    expect(events.filter((event) => event.event_type === 'load').length).toBe(1)
  })
})
