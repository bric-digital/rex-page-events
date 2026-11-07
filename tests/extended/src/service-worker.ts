// @ts-nocheck

import './slow-configuration'
import rexCorePlugin, {
  registerREXModule,
  REXServiceWorkerModule,
} from '@bric/rex-core/service-worker'
import rexPageEventsPlugin, {
  subscribeUrlActive,
} from '@bric/rex-page-events/service-worker'
import { createListEntry } from '@bric/rex-lists'
import * as linkFollow from '../../../src/link-follow.mjs'
import * as followStateRules from '../../../src/follow-state.mjs'

self['__capturedEvents'] = []
self['__capturedUrlActive'] = []

class EventCaptureModule extends REXServiceWorkerModule {
  moduleName() {
    return 'EventCapture'
  }
  setup() { /* no-op */ }
  handleMessage() { return false }
  logEvent(event) {
    self['__capturedEvents'].push(event)
  }
}

registerREXModule(new EventCaptureModule())

subscribeUrlActive((record) => {
  self['__capturedUrlActive'].push(record)
})

self['rexCorePlugin'] = rexCorePlugin
self['rexPageEventsPlugin'] = rexPageEventsPlugin
self['createListEntry'] = createListEntry
self['linkFollow'] = linkFollow
self['followStateRules'] = followStateRules

rexCorePlugin.setup()
