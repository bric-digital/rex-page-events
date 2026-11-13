// @ts-nocheck

import './slow-configuration'
import rexCorePlugin, {
  registerREXModule,
  REXServiceWorkerModule,
} from '@bric/rex-core/service-worker'
import rexPageEventsPlugin from '@bric/rex-page-events/service-worker'

self['__capturedEvents'] = []
self['__capturedUrlActive'] = []

class EventCaptureModule extends REXServiceWorkerModule {
  moduleName() {
    return 'EventCapture'
  }
  setup() { /* no-op */ }
  handleMessage(message, sender, sendResponse) {
    if (message.messageType !== 'pageUrlActive') {
      return false
    }

    self['__capturedUrlActive'].push(message.event)
    sendResponse({ success: true })
    return true
  }
  logEvent(event) {
    self['__capturedEvents'].push(event)
  }
}

class ThrowingUrlActiveModule extends REXServiceWorkerModule {
  moduleName() {
    return 'ThrowingUrlActive'
  }
  setup() { /* no-op */ }
  handleMessage(message) {
    if (message.messageType === 'pageUrlActive' && self['__throwOnUrlActive'] === true) {
      throw new Error('test module throws on url-active')
    }

    return false
  }
}

registerREXModule(new EventCaptureModule())
registerREXModule(new ThrowingUrlActiveModule())

self['rexCorePlugin'] = rexCorePlugin
self['rexPageEventsPlugin'] = rexPageEventsPlugin

rexCorePlugin.setup()
