// @ts-nocheck

import { test, expect, BASE_CONFIG, loadConfig, waitForPageEventsConfig, resetCaptured } from './fixtures.js'

function configWith(pageEvents) {
  return { ...BASE_CONFIG, page_events: { enabled: true, ...pageEvents } }
}

async function addListEntry(serviceWorker, listName, host, category) {
  await serviceWorker.evaluate(async ({ listName, host, category }) => {
    await self.createListEntry({
      list_name: listName,
      pattern: host,
      pattern_type: 'host',
      source: 'backend',
      metadata: { category },
    })
  }, { listName, host, category })
}

async function openTab(serviceWorker, url) {
  return serviceWorker.evaluate(async (tabUrl) => {
    const tab = await chrome.tabs.create({ url: tabUrl })
    return tab.id
  }, url)
}

async function recordsFor(serviceWorker, tabId) {
  return serviceWorker.evaluate((id) => {
    return self.__capturedEvents.filter((e) => e.name === 'rex-page-event' && e.tab_id === id)
  }, tabId)
}

async function tabOpenRecord(serviceWorker, tabId) {
  await expect.poll(async () => {
    const records = await recordsFor(serviceWorker, tabId)
    return records.some((e) => e.event_type === 'tab_open')
  }, { timeout: 5000 }).toBe(true)

  const records = await recordsFor(serviceWorker, tabId)
  return records.find((e) => e.event_type === 'tab_open')
}

async function start(serviceWorker, config) {
  await loadConfig(serviceWorker, config)
  await waitForPageEventsConfig(serviceWorker)
  await resetCaptured(serviceWorker)
}

test.describe('Address configuration', () => {
  test('with no allow list and no allow_all, the address is replaced', async ({ serviceWorker }) => {
    await start(serviceWorker, configWith({}))

    const tabId = await openTab(serviceWorker, 'https://example.org/hidden')
    const record = await tabOpenRecord(serviceWorker, tabId)

    expect(record.url).toBe('CATEGORY:NOT_ON_ALLOWLIST')
    expect(record.filtered_by_list).toBe('NOT_ON_ALLOWLIST')
    expect(record.title).toBeUndefined()
  })

  test('with no allow list, the url-active feed still carries the address', async ({ serviceWorker }) => {
    await start(serviceWorker, configWith({}))

    const tabId = await openTab(serviceWorker, 'https://example.org/feed')
    await tabOpenRecord(serviceWorker, tabId)

    const active = await serviceWorker.evaluate((id) => {
      return self.__capturedUrlActive.find((r) => r.tab_id === id)
    }, tabId)
    expect(active.url).toContain('example.org/feed')
  })

  test('allow_all keeps the address', async ({ serviceWorker }) => {
    await start(serviceWorker, configWith({ allow_all: true }))

    const tabId = await openTab(serviceWorker, 'https://example.org/kept')
    const record = await tabOpenRecord(serviceWorker, tabId)

    expect(record.url).toContain('example.org/kept')
    expect(record.filtered).toBe(false)
  })

  test('a filter list takes precedence over allow_all', async ({ serviceWorker }) => {
    await addListEntry(serviceWorker, 'test-filter', 'example.com', 'TEST_FILTERED')
    await start(serviceWorker, configWith({ allow_all: true, filter_lists: ['test-filter'] }))

    const filteredTabId = await openTab(serviceWorker, 'https://example.com/private')
    const filtered = await tabOpenRecord(serviceWorker, filteredTabId)
    expect(filtered.url).toBe('CATEGORY:TEST_FILTERED')
    expect(filtered.filtered_by_list).toBe('test-filter')

    const keptTabId = await openTab(serviceWorker, 'https://example.org/public')
    const kept = await tabOpenRecord(serviceWorker, keptTabId)
    expect(kept.url).toContain('example.org/public')
  })

  test('a domain-only list keeps the hostname of a URL that is not allowed', async ({ serviceWorker }) => {
    await addListEntry(serviceWorker, 'test-domain-only', 'example.net', 'TEST_DOMAIN')
    await start(serviceWorker, configWith({ domain_only_lists: ['test-domain-only'] }))

    const tabId = await openTab(serviceWorker, 'https://example.net/page')
    const record = await tabOpenRecord(serviceWorker, tabId)

    expect(record.url).toBe('example.net')
    expect(record.title).toBe('DOMAIN ONLY')
    expect(record.filtered_by_list).toBe('test-domain-only')
  })

  test('a domain-only list takes precedence over a filter list', async ({ serviceWorker }) => {
    await addListEntry(serviceWorker, 'test-both-filter', 'example.edu', 'TEST_FILTERED')
    await addListEntry(serviceWorker, 'test-both-domain-only', 'example.edu', 'TEST_DOMAIN')
    await start(serviceWorker, configWith({
      allow_all: true,
      filter_lists: ['test-both-filter'],
      domain_only_lists: ['test-both-domain-only'],
    }))

    const tabId = await openTab(serviceWorker, 'https://example.edu/page')
    const record = await tabOpenRecord(serviceWorker, tabId)

    expect(record.url).toBe('example.edu')
    expect(record.filtered_by_list).toBe('test-both-domain-only')
  })
})

test.describe('Event type configuration', () => {
  test('an event type set to false is not recorded, and the others still are', async ({ serviceWorker }) => {
    await start(serviceWorker, configWith({ allow_all: true, event_types: { tab_open: false } }))

    const tabId = await openTab(serviceWorker, 'https://example.org/switched')
    await serviceWorker.evaluate(async (id) => {
      await new Promise((r) => setTimeout(r, 300))
      await chrome.tabs.remove(id)
    }, tabId)

    await expect.poll(async () => {
      const records = await recordsFor(serviceWorker, tabId)
      return records.some((e) => e.event_type === 'tab_close')
    }, { timeout: 5000 }).toBe(true)

    const records = await recordsFor(serviceWorker, tabId)
    expect(records.filter((e) => e.event_type === 'tab_open')).toHaveLength(0)
  })

  test('an event type set to true is recorded, as by default', async ({ serviceWorker }) => {
    await start(serviceWorker, configWith({ allow_all: true, event_types: { tab_open: true } }))

    const tabId = await openTab(serviceWorker, 'https://example.org/on')
    const record = await tabOpenRecord(serviceWorker, tabId)

    expect(record.event_type).toBe('tab_open')
  })
})
