// @ts-nocheck

// Implements the necessary functionality to load the REX modules into the 
// extension background service worker context.

import rexCorePlugin, { REXServiceWorkerModule, registerREXModule } from '@bric/rex-core/service-worker'
import rexPageEventsPlugin from '@bric/rex-page-events/service-worker'
import { createListEntry } from '@bric/rex-lists'

console.log(`Imported ${rexCorePlugin} into service worker context...`)
console.log(`Imported ${rexPageEventsPlugin} into service worker context...`)

self['rexCorePlugin'] = rexCorePlugin
self['rexPageEventsPlugin'] = rexPageEventsPlugin

class TestPageEventsModule extends REXServiceWorkerModule {
  loggedEvents:[any] = []

  moduleName() {
    return 'TestPageEventsModule'
  }

  setup() {
    chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
      this.handleMessage(message, sender, sendResponse)
    })
  }

  logEvent(event:any) {
    console.log('logEvent')
    console.log(event)

    if (event !== undefined) {
      if (['', null, undefined].includes(event['name']) == false) {
        this.loggedEvents.push(event)
      }
    }
  }

  handleMessage(message:any, sender:any, sendResponse:(response:any) => void):boolean  { // eslint-disable-line @typescript-eslint/no-explicit-any
    console.log('message')
    console.log(message)
    
    if (message.messageType == 'fetchLoggedTestEvents') {
      sendResponse(this.loggedEvents)

      return true
    }

    return false
  }
}

const testModule = new TestPageEventsModule()

registerREXModule(testModule)

self['rexTestPageEvents'] = rexCorePlugin

console.log(`Imported ${rexTestPageEvents} into service worker context...`)

createListEntry({
  list_name: 'test-localhost',
  pattern: 'localhost',
  pattern_type: 'host',
  source: 'backend',
  metadata: { category: 'ALLOWED' },
})

rexCorePlugin.setup()
