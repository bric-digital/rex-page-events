// @ts-nocheck

import { test, expect, BASE_CONFIG, loadConfig, waitForPageEventsConfig, resetCaptured } from './fixtures.js'

const TEST_ORIGIN = 'https://pages.test'
const HELD_IMAGE_PATH = '/held.png'
const SETTLE_MS = 2000

let pageCount = 0

async function startModule(serviceWorker) {
  await loadConfig(serviceWorker, BASE_CONFIG)
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

async function pageEventsOf(serviceWorker, eventType) {
  return serviceWorker.evaluate((type) => {
    return self.__capturedEvents.filter((event) => event.event_type === type)
  }, eventType)
}

test.describe('REX Page Events in pages', () => {
  test('navigating away records page_hide with persisted false (the unload, D63)', async ({ context, serviceWorker }) => {
    await startModule(serviceWorker)

    const { page, url } = await openTestPage(context, '<p>First page</p>')

    await page.waitForTimeout(SETTLE_MS)
    await page.goto(`${TEST_ORIGIN}/next`)

    await expect.poll(async () => {
      const hides = await pageEventsOf(serviceWorker, 'page_hide')

      return hides.filter((event) => event.url === url).map((event) => event.persisted)
    }, { timeout: 5000 }).toEqual([false])
  })
})
