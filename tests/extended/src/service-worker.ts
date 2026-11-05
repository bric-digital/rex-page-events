// @ts-nocheck

import rexCorePlugin, {
  registerREXModule,
  REXServiceWorkerModule,
} from '@bric/rex-core/service-worker'
import rexPageEventsPlugin, {
  subscribeUrlActive,
} from '@bric/rex-page-events/service-worker'

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

rexCorePlugin.setup()
