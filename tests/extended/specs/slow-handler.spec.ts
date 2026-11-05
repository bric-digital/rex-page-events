import { test, expect, BASE_CONFIG, loadConfig, waitForPageEventsConfig } from './fixtures'

async function recordWarnings(serviceWorker) {
  await serviceWorker.evaluate(() => {
    self.__warnings = []
    const originalWarn = console.warn
    console.warn = (...args) => {
      self.__warnings.push(String(args[0]))
      originalWarn(...args)
    }
  })
}

async function slowWarnings(serviceWorker) {
  return serviceWorker.evaluate(() => self.__warnings.filter((message) => message.includes('still running')))
}

test('a handler that never finishes logs a warning after 10 s', async ({ serviceWorker }) => {
  test.setTimeout(40000)
  await loadConfig(serviceWorker, BASE_CONFIG)
  await waitForPageEventsConfig(serviceWorker)
  await recordWarnings(serviceWorker)

  await serviceWorker.evaluate(() => {
    chrome.storage.session.set = () => new Promise(() => {})
  })
  await serviceWorker.evaluate(() => chrome.tabs.create({ url: 'https://example.org/stalled' }))

  await new Promise((resolve) => setTimeout(resolve, 8000))
  expect(await slowWarnings(serviceWorker)).toEqual([])

  await new Promise((resolve) => setTimeout(resolve, 4000))
  expect(await slowWarnings(serviceWorker)).toEqual(['[rex-page-events] handler still running after 10000 ms'])
})

test('handlers that finish log no warning (control)', async ({ serviceWorker }) => {
  test.setTimeout(40000)
  await loadConfig(serviceWorker, BASE_CONFIG)
  await waitForPageEventsConfig(serviceWorker)
  await recordWarnings(serviceWorker)

  await serviceWorker.evaluate(() => chrome.tabs.create({ url: 'https://example.org/normal' }))

  await new Promise((resolve) => setTimeout(resolve, 12000))
  expect(await slowWarnings(serviceWorker)).toEqual([])
})
