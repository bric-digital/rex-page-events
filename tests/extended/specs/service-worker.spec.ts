// @ts-nocheck

import { test, expect, BASE_CONFIG, loadConfig, waitForPageEventsConfig, resetCaptured } from './fixtures.js'

async function getCaptured(serviceWorker) {
  return serviceWorker.evaluate(() => ({
    events: self.__capturedEvents,
    urlActive: self.__capturedUrlActive,
  }))
}

test.describe('REX Page Events', () => {
  test('service worker loads plugin and identifier can be set', async ({ serviceWorker }) => {
    await loadConfig(serviceWorker, BASE_CONFIG)

    const identifier = await serviceWorker.evaluate(async () => {
      return new Promise((resolve) => {
        self.rexCorePlugin.handleMessage({
          messageType: 'setIdentifier',
          identifier: 'i-am-rex',
        }, this, () => {
          chrome.storage.local.get('rexIdentifier').then((r) => resolve(r.rexIdentifier))
        })
      })
    })

    expect(identifier).toEqual('i-am-rex')
  })

  test('url-active seam is installed on globalThis', async ({ serviceWorker }) => {
    await loadConfig(serviceWorker, BASE_CONFIG)
    await waitForPageEventsConfig(serviceWorker)

    const hasSeam = await serviceWorker.evaluate(() => {
      const seam = globalThis.__rexPageEventsUrlActive
      return seam !== undefined && typeof seam.subscribe === 'function'
    })

    expect(hasSeam).toBe(true)
  })

  test('creating a tab emits tab_open and delivers url-active', async ({ serviceWorker }) => {
    await loadConfig(serviceWorker, BASE_CONFIG)
    await waitForPageEventsConfig(serviceWorker)
    await resetCaptured(serviceWorker)

    const tabId = await serviceWorker.evaluate(async () => {
      const tab = await chrome.tabs.create({ url: 'https://example.org/a' })
      return tab.id
    })

    await expect.poll(async () => {
      const { events } = await getCaptured(serviceWorker)
      return events.filter((e) => e.event_type === 'tab_open' && e.tab_id === tabId).length
    }, { timeout: 5000 }).toBeGreaterThanOrEqual(1)

    const { events, urlActive } = await getCaptured(serviceWorker)
    const tabOpen = events.find((e) => e.event_type === 'tab_open' && e.tab_id === tabId)
    expect(tabOpen.name).toBe('rex-page-event')
    expect(tabOpen.session_id).toBeTruthy()
    expect(tabOpen.window_id).toBeGreaterThanOrEqual(0)

    const active = urlActive.find((r) => r.tab_id === tabId)
    expect(active).toBeTruthy()
    expect(active.name).toBe('rex-page-url-active')
    expect(active.session_id).toBe(tabOpen.session_id)
  })

  test('url change emits tab_url_change describing outgoing URL', async ({ serviceWorker }) => {
    await loadConfig(serviceWorker, BASE_CONFIG)
    await waitForPageEventsConfig(serviceWorker)
    await resetCaptured(serviceWorker)

    const tabId = await serviceWorker.evaluate(async () => {
      const tab = await chrome.tabs.create({ url: 'https://example.org/first' })
      return tab.id
    })

    await expect.poll(async () => {
      const { events } = await getCaptured(serviceWorker)
      return events.some((e) => e.event_type === 'tab_open' && e.tab_id === tabId)
    }, { timeout: 5000 }).toBe(true)

    await serviceWorker.evaluate(async (id) => {
      await chrome.tabs.update(id, { url: 'https://example.org/second' })
    }, tabId)

    await expect.poll(async () => {
      const { events } = await getCaptured(serviceWorker)
      return events.filter((e) => e.event_type === 'tab_url_change' && e.tab_id === tabId).length
    }, { timeout: 5000 }).toBeGreaterThanOrEqual(1)

    const { events } = await getCaptured(serviceWorker)
    const change = events.find((e) => e.event_type === 'tab_url_change' && e.tab_id === tabId)
    expect(change.url).toContain('example.org/first')
    expect(typeof change.url_dwell_ms).toBe('number')
    expect(change.url_dwell_ms).toBeGreaterThanOrEqual(0)
  })

  test('closing a tab emits tab_close with lifetime stats', async ({ serviceWorker }) => {
    await loadConfig(serviceWorker, BASE_CONFIG)
    await waitForPageEventsConfig(serviceWorker)
    await resetCaptured(serviceWorker)

    const tabId = await serviceWorker.evaluate(async () => {
      const tab = await chrome.tabs.create({ url: 'https://example.org/lifetime' })
      return tab.id
    })

    await expect.poll(async () => {
      const { events } = await getCaptured(serviceWorker)
      return events.some((e) => e.event_type === 'tab_open' && e.tab_id === tabId)
    }, { timeout: 5000 }).toBe(true)

    await serviceWorker.evaluate(async (id) => {
      await new Promise((r) => setTimeout(r, 50))
      await chrome.tabs.remove(id)
    }, tabId)

    await expect.poll(async () => {
      const { events } = await getCaptured(serviceWorker)
      return events.filter((e) => e.event_type === 'tab_close' && e.tab_id === tabId).length
    }, { timeout: 5000 }).toBeGreaterThanOrEqual(1)

    const { events } = await getCaptured(serviceWorker)
    const close = events.find((e) => e.event_type === 'tab_close' && e.tab_id === tabId)
    expect(typeof close.tab_lifetime_ms).toBe('number')
    expect(close.tab_lifetime_ms).toBeGreaterThan(0)
    expect(typeof close.focus_duration_ms).toBe('number')
  })

  test('enabled: false from the start suppresses events', async ({ serviceWorker }) => {
    const disabled = { ...BASE_CONFIG, page_events: { enabled: false } }
    await loadConfig(serviceWorker, disabled)
    await waitForPageEventsConfig(serviceWorker)
    await resetCaptured(serviceWorker)

    await serviceWorker.evaluate(async () => {
      const tab = await chrome.tabs.create({ url: 'https://example.org/ignored' })
      await new Promise((r) => setTimeout(r, 500))
      await chrome.tabs.remove(tab.id)
    })

    await new Promise((r) => setTimeout(r, 300))
    const { events } = await getCaptured(serviceWorker)
    expect(events.filter((e) => e.name === 'rex-page-event').length).toBe(0)
  })
})
