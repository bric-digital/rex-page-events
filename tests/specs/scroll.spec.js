import { test, expect } from './fixtures.js';

const startupDelay = 1000
const scrollDistance = 1500
const positionFields = ['top', 'left', 'width', 'height', 'document_height', 'document_width']

function fetchLoggedEvents(page, extensionId) {
  return page.evaluate(async ([extensionId]) => {
    return chrome.runtime.sendMessage(extensionId, {
      'messageType': 'fetchLoggedTestEvents'
    })
  }, [extensionId])
}

function scrollEventsIn(loggedEvents) {
  return loggedEvents.filter((event) => event['event_type'] === 'scroll')
}

test.describe('REX Page Events - Scroll Test', () => {

  test('Test that a scroll on the pizza page is recorded with its position.', async ({ page, extensionId }) => {
    test.setTimeout(60_000)

    console.log('Waiting for extension to load...')
    await page.waitForTimeout(startupDelay)

    console.log('Waiting for the pizza page to load...')
    await page.goto('/pizza_near_me.html')

    console.log('Waiting for extension to load into the page...')
    await page.waitForTimeout(startupDelay)

    await expect(page.getByText('THE MART, 222 W Merchandise Mart Plaza, Chicago')).toBeVisible()

    const { documentHeight, viewportHeight } = await page.evaluate(() => ({
      documentHeight: document.documentElement.scrollHeight,
      viewportHeight: document.documentElement.clientHeight,
    }))

    if (documentHeight <= viewportHeight + scrollDistance) {
      throw new Error(`Test setup invalid: the page is ${documentHeight}px tall in a ${viewportHeight}px window, so it cannot scroll ${scrollDistance}px and the test cannot tell a real scroll from the one recorded at load.`)
    }

    console.log('Scrolling...')
    await page.mouse.move(400, 300)
    await page.mouse.wheel(0, scrollDistance)

    await expect.poll(async () => {
      const scrolled = scrollEventsIn(await fetchLoggedEvents(page, extensionId))
        .filter((event) => event['scroll_position']?.['top'] > 0)

      return scrolled.length
    }, { message: 'a scroll event with scroll_position.top above 0', timeout: 10_000 }).toBeGreaterThan(0)

    const scrollEvents = scrollEventsIn(await fetchLoggedEvents(page, extensionId))

    for (const event of scrollEvents) {
      const position = event['scroll_position']
      console.log('Scroll event:')
      console.log(event)

      for (const field of positionFields) {
        expect(Number.isInteger(position?.[field]), `scroll_position.${field} in ${JSON.stringify(event)}`).toBe(true)
      }
    }
  })
})
