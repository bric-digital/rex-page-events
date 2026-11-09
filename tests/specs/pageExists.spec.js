import { test, expect } from './fixtures.js';

const startupDelay = 1000

test.describe('REX Page Events - Pizza Page Exists', () => {
  // Test if pizza page is loading...

  test('Test that pizza page loads.', async ({ page, extensionId }) => {
    test.setTimeout(60_000)
    
    console.log('Waiting for extension to load...')
    await page.waitForTimeout(startupDelay)

    console.log('Waiting for the pizza page to load...')
    await page.goto('/pizza_near_me.html')

    console.log('Waiting for extension to load into the page...')

    await page.waitForTimeout(startupDelay)

    console.log('Running tests...')

    await expect(page.getByText('THE MART, 222 W Merchandise Mart Plaza, Chicago')).toBeVisible()

    await expect(page).toHaveTitle('pizza near merchandise mart - Google Search')

    await page.waitForTimeout(startupDelay);

    const loggedEvents = await page.evaluate(async ([extensionId]) => {
      return chrome.runtime.sendMessage(extensionId, {
        'messageType': 'fetchLoggedTestEvents'
      })
    }, [extensionId])

    await expect(loggedEvents.length).toBeGreaterThan(0)

    let loadFound = false

    for (const event of loggedEvents) {
      if (event['event_type'] === 'load') {
        loadFound = true
      }
    }

    await expect(loadFound).toBe(true)
  })
})
