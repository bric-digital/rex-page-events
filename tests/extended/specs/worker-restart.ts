import { type BrowserContext, type CDPSession, type Page } from '@playwright/test'

import { expect } from './fixtures.js'

interface TargetInfo {
  targetId: string
  type: string
}

async function workerTargets(cdp: CDPSession): Promise<TargetInfo[]> {
  const { targetInfos } = await cdp.send('Target.getTargets')

  return targetInfos.filter((target: TargetInfo) => target.type === 'service_worker')
}

export async function stopServiceWorker(context: BrowserContext, page: Page) {
  const cdp = await context.newCDPSession(page)

  await cdp.send('ServiceWorker.enable')
  await cdp.send('ServiceWorker.stopAllWorkers')

  await expect.poll(async () => (await workerTargets(cdp)).length, { timeout: 5000 }).toBe(0)

  await cdp.detach()
}

export async function evaluateInRestartedWorker(context: BrowserContext, page: Page, expression: string): Promise<unknown> {
  const cdp = await context.newCDPSession(page)

  await expect.poll(async () => (await workerTargets(cdp)).length, { timeout: 5000 }).toBeGreaterThan(0)

  const [target] = await workerTargets(cdp)
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false })

  const messageId = 1
  const answer = new Promise<unknown>((resolve) => {
    cdp.on('Target.receivedMessageFromTarget', (event) => {
      const message = JSON.parse(event.message)

      if (event.sessionId === sessionId && message.id === messageId) {
        resolve(message.result?.result?.value)
      }
    })
  })

  await cdp.send('Target.sendMessageToTarget', {
    sessionId,
    message: JSON.stringify({
      id: messageId,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true },
    }),
  })

  const value = await answer

  await cdp.detach()

  return value
}
