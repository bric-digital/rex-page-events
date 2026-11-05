import { test, expect } from './fixtures.js';

const startupDelay = 1000

test.describe('REX Page Events - Basic Loading', () => {
  // Test if tests are working...

  test('Test that page loads.', async ({ page, extensionId }) => {
    test.setTimeout(60_000)
    
    console.log('Waiting for extension to load...')
    await page.waitForTimeout(startupDelay)

    console.log('Waiting for page to load...')
    await page.goto('/load.html')

    console.log('Waiting for extension to load into the page...')

    await page.waitForTimeout(startupDelay)

    console.log('Running tests...')

    await expect(page.getByText('The only way to pass a test is to take the test.')).toBeVisible()

    const isREXLoaded = await page.locator('#rex_here').textContent()

    await expect(isREXLoaded).toBeTruthy()

    await page.waitForTimeout(startupDelay);

    const loggedEvents = await page.evaluate(async ([extensionId]) => {
      console.log(`extensionId: ${extensionId}`)

      return chrome.runtime.sendMessage(extensionId, {
        'messageType': 'fetchLoggedTestEvents'
      })
    }, [extensionId])

    console.log(`loggedEvents: ${loggedEvents}`)

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
