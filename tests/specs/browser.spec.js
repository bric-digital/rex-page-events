import { test, expect } from './fixtures.js';

const startupDelay = 2500

test.describe('REX Page Events - Basic Loading', () => {
  // Test if tests are working...

  test('Test that page loads.', async ({ page, extensionId }) => {
    await page.waitForTimeout(startupDelay);

    await page.goto('/');

    await page.waitForTimeout(startupDelay);

    await expect(page.getByText('The only way to pass a test is to take the test.')).toBeVisible()

    const isREXLoaded = await page.locator('div#rex_here').textContent()

    await expect(isREXLoaded).toBeTruthy()

    const loggedEvents = await page.evaluate(async ([extensionId]) => {
      console.log(`extensionId: ${extensionId}`)

      return chrome.runtime.sendMessage(extensionId, {
        'messageType': 'fetchLoggedTestEvents'
      })

      // return new Promise((testResolve) => {
      //   chrome.runtime.sendMessage(extensionId, {
      //     'messageType': 'fetchLoggedTestEvents'
      //   }).then((logged) => {
      //     console.log(`logged: ${logged}`)

      //     testResolve(logged)
      //   })
      // })
    }, [extensionId])

    console.log(`loggedEvents: ${loggedEvents}`)

    await expect(loggedEvents).toBe('foobar')
  })
})
