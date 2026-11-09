import { test, expect } from './fixtures.js';

const startupDelay = 1000
const scrollDistance = 1500
const pageHeight = 4800
const positionFields = ['top', 'left', 'width', 'height', 'document_height', 'document_width']

function fetchLoggedEvents(page, extensionId) {
  return page.evaluate(async ([extensionId]) => {
    return chrome.runtime.sendMessage(extensionId, {
      'messageType': 'fetchLoggedTestEvents'
    })
  }, [extensionId])
}

async function latestScrollPosition(page, extensionId) {
  const scrollEvents = (await fetchLoggedEvents(page, extensionId))
    .filter((event) => event['event_type'] === 'scroll')

  return scrollEvents.at(-1)?.['scroll_position']
}

test.describe('REX Page Events - Scroll Test', () => {

  test('Test that a scroll is recorded with its position.', async ({ page, extensionId }) => {
    test.setTimeout(60_000)

    console.log('Waiting for extension to load...')
    await page.waitForTimeout(startupDelay)

    console.log('Waiting for the scroll page to load...')
    await page.goto('/scroll.html')

    console.log('Waiting for extension to load into the page...')
    await page.waitForTimeout(startupDelay)

    await expect(page.getByText('Scroll test page')).toBeVisible()

    const documentHeight = await page.evaluate(() => document.documentElement.scrollHeight)

    if (documentHeight !== pageHeight) {
      throw new Error(`Test setup invalid: scroll.html is ${documentHeight}px tall, not ${pageHeight}px, so the expected position no longer describes the page.`)
    }

    console.log('Scrolling...')
    await page.mouse.move(400, 300)
    await page.mouse.wheel(0, scrollDistance)

    await expect.poll(() => latestScrollPosition(page, extensionId), {
      message: 'the latest scroll event records the scroll',
      timeout: 10_000,
    }).toEqual(expect.objectContaining({
      top: scrollDistance,
      left: 0,
      document_height: pageHeight,
    }))

    const position = await latestScrollPosition(page, extensionId)

    for (const field of positionFields) {
      expect(Number.isInteger(position[field]), `scroll_position.${field} in ${JSON.stringify(position)}`).toBe(true)
    }
  })
})
