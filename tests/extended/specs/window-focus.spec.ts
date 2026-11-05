// @ts-nocheck

import { test, expect, BASE_CONFIG, loadConfig, waitForPageEventsConfig, resetCaptured } from './fixtures.js'

async function focusEvents(serviceWorker, tabIds) {
  const events = await serviceWorker.evaluate(() => self.__capturedEvents)

  return events
    .filter((event) => ['tab_focus', 'tab_blur'].includes(event.event_type) && tabIds.includes(event.tab_id))
    .map((event) => `${event.event_type} ${tabIds.indexOf(event.tab_id) === 0 ? 'first' : 'second'}`)
}

async function openTwoWindows(serviceWorker) {
  return serviceWorker.evaluate(async () => {
    const first = await chrome.windows.create({ url: 'https://example.org/first', focused: true })
    const second = await chrome.windows.create({ url: 'https://example.org/second', focused: true })

    return { first: { windowId: first.id, tabId: first.tabs[0].id }, second: { windowId: second.id, tabId: second.tabs[0].id } }
  })
}

// Playwright's Chromium fires no windows.onFocusChanged, so each test passes the module the event Chrome sends.
test.describe('Window focus', () => {
  test('focusing another window blurs the tab in the window that lost focus and focuses the active tab of the one that gained it', async ({ serviceWorker }) => {
    await loadConfig(serviceWorker, BASE_CONFIG)
    await waitForPageEventsConfig(serviceWorker)
    const windows = await openTwoWindows(serviceWorker)
    const tabIds = [windows.first.tabId, windows.second.tabId]
    await serviceWorker.evaluate(() => new Promise((resolve) => setTimeout(resolve, 1000)))
    await resetCaptured(serviceWorker)

    await serviceWorker.evaluate((windowId) => self.rexPageEventsPlugin.onWindowFocusChanged(windowId), windows.first.windowId)

    await expect.poll(() => focusEvents(serviceWorker, tabIds), { timeout: 5000 }).toEqual(expect.arrayContaining(['tab_blur second', 'tab_focus first']))
  })

  test('a window regaining focus after the browser lost it restarts its active tab focus', async ({ serviceWorker }) => {
    await loadConfig(serviceWorker, BASE_CONFIG)
    await waitForPageEventsConfig(serviceWorker)
    const windows = await openTwoWindows(serviceWorker)
    const tabIds = [windows.first.tabId, windows.second.tabId]
    await serviceWorker.evaluate(() => new Promise((resolve) => setTimeout(resolve, 1000)))

    await serviceWorker.evaluate(() => self.rexPageEventsPlugin.onWindowFocusChanged(chrome.windows.WINDOW_ID_NONE))
    await resetCaptured(serviceWorker)

    await serviceWorker.evaluate((windowId) => self.rexPageEventsPlugin.onWindowFocusChanged(windowId), windows.second.windowId)

    await expect.poll(() => focusEvents(serviceWorker, tabIds), { timeout: 5000 }).toEqual(['tab_focus second'])
  })
})
