import { type RexPageUrlActiveEvent } from '@bric/rex-types/types'

const LOG_PREFIX = '[rex-page-events]'

export type UrlActiveListener = (event: RexPageUrlActiveEvent) => void

const urlActiveListeners: Set<UrlActiveListener> = new Set()

export function subscribeUrlActive(listener: UrlActiveListener): () => void {
  urlActiveListeners.add(listener)
  return () => {
    urlActiveListeners.delete(listener)
  }
}

export function deliverUrlActive(record: RexPageUrlActiveEvent): void {
  for (const listener of urlActiveListeners) {
    try {
      listener(record)
    } catch (err) {
      console.warn(`${LOG_PREFIX} url-active listener threw`, err)
    }
  }
}
