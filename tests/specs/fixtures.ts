// @ts-nocheck

import { test as base, chromium, type BrowserContext } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url';

export const test = base.extend<{
  backForwardCache: boolean
  context: BrowserContext
  extensionId: string,
  serviceWorker:ServiceWorker,
}>({
  backForwardCache: [false, { option: true }],
  context: async ({ backForwardCache }, use) => {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);

    const pathToExtension = path.join(__dirname, '../extension')

    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      ignoreDefaultArgs: backForwardCache === true ? ['--disable-back-forward-cache'] : [],
      args: [
        `--disable-extensions-except=${pathToExtension}`,
        `--load-extension=${pathToExtension}`,
      ],
    });

    await use(context)
    await context.close()
  },
  extensionId: async ({ context }, use) => {
    let [serviceWorker] = context.serviceWorkers();
    if (!serviceWorker)
      serviceWorker = await context.waitForEvent('serviceworker');

    const extensionId = serviceWorker.url().split('/')[2];
    await use(extensionId);
  },
  serviceWorker: async ({ context }, use) => {
    let [serviceWorker] = context.serviceWorkers();
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent('serviceworker');
    }

    await use(serviceWorker)
  },
});

export const expect = test.expect;

export const BASE_CONFIG = {
  configuration_url: 'config.json',
  identifier: 'rex-page-events-test',
  page_events: {
    enabled: true,
  },
  ui: [{
    title: 'Test',
    identifier: 'main',
    default: true,
  }],
}

export async function loadConfig(serviceWorker, config) {
  return serviceWorker.evaluate(async (configArg) => {
    return new Promise((resolve) => {
      self.rexCorePlugin.handleMessage({
        messageType: 'loadInitialConfiguration',
        configuration: configArg,
      }, this, (response) => resolve(response))
    })
  }, config)
}

export async function waitForPageEventsConfig(serviceWorker) {
  await serviceWorker.evaluate(async () => {
    return new Promise((resolve) => {
      const check = () => {
        if (self.rexPageEventsPlugin?.config) {
          resolve()
        } else {
          setTimeout(check, 100)
        }
      }
      check()
    })
  })
}

export async function resetCaptured(serviceWorker) {
  await serviceWorker.evaluate(() => {
    self.__capturedEvents = []
    self.__capturedUrlActive = []
  })
}
