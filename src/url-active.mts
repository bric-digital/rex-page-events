import rexCorePlugin from '@bric/rex-core/service-worker'
import { type RexPageUrlActiveEvent } from '@bric/rex-types/types'

const LOG_PREFIX = '[rex-page-events]'
const URL_ACTIVE_MESSAGE_TYPE = 'pageUrlActive'

export function deliverUrlActive(record: RexPageUrlActiveEvent): void {
  try {
    rexCorePlugin.handleMessage({ messageType: URL_ACTIVE_MESSAGE_TYPE, event: record }, null, () => undefined)
  } catch (err) {
    console.warn(`${LOG_PREFIX} a module failed on a url-active message`, err)
  }
}
