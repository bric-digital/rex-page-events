import { REXClientModule, registerREXModule } from '@bric/rex-core/browser'

import { type PageEventMessage, type ScrollPosition } from './types.mjs'

const SCROLL_PAUSE_MS = 250

function loadStartTime(): number {
  const [navigation] = window.performance.getEntriesByType('navigation') as PerformanceNavigationTiming[]

  return Math.round(window.performance.timeOrigin + navigation.loadEventStart)
}

function scrollPosition(): ScrollPosition {
  return {
    top: window.scrollY,
    left: window.scrollX,
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight,
    document_height: document.documentElement.scrollHeight,
    document_width: document.documentElement.scrollWidth,
  }
}

class REXPageEventsModule extends REXClientModule {
  private scrollTimer: ReturnType<typeof setTimeout> | null = null
  toString(): string {
    return 'REXPageEventsModule'
  }

  setup() {
    console.log('[rex-page-events] browser setup')

    this.recordLoad()
    this.watchScroll()

    window.addEventListener('pageshow', (event: PageTransitionEvent) => {
      this.send({
        messageType: 'pageEvent',
        event_type: 'page_show',
        url: location.href,
        title: document.title,
        timestamp: Date.now(),
        persisted: event.persisted,
      })
    })

    window.addEventListener('pagehide', (event: PageTransitionEvent) => {
      this.send({
        messageType: 'pageEvent',
        event_type: 'page_hide',
        url: location.href,
        title: document.title,
        timestamp: Date.now(),
        persisted: event.persisted,
      })
    })

    window.addEventListener('focus', () => {
      this.send({
        messageType: 'pageEvent',
        event_type: 'tab_focus',
        url: location.href,
        title: document.title,
        timestamp: Date.now(),
      })
    })

    window.addEventListener('blur', () => {
      this.send({
        messageType: 'pageEvent',
        event_type: 'tab_blur',
        url: location.href,
        title: document.title,
        timestamp: Date.now(),
      })
    })
  }

  private recordLoad(): void {
    const sendLoad = () => {
      this.send({
        messageType: 'pageEvent',
        event_type: 'load',
        url: location.href,
        title: document.title,
        timestamp: loadStartTime(),
      })
    }

    if (document.readyState === 'complete') {
      sendLoad()
    } else {
      window.addEventListener('load', sendLoad, { once: true })
    }
  }

  private watchScroll(): void {
    this.recordScroll()

    window.addEventListener('scroll', () => {
      this.scheduleScroll()
    })

    window.addEventListener('pagehide', () => {
      this.flushScroll()
    })

    window.addEventListener('pageshow', (event: PageTransitionEvent) => {
      if (event.persisted === true) {
        this.recordScroll()
      }
    })
  }

  private scheduleScroll(): void {
    if (this.scrollTimer !== null) {
      clearTimeout(this.scrollTimer)
    }

    this.scrollTimer = setTimeout(() => {
      this.scrollTimer = null
      this.recordScroll()
    }, SCROLL_PAUSE_MS)
  }

  private flushScroll(): void {
    if (this.scrollTimer === null) {
      return
    }

    clearTimeout(this.scrollTimer)
    this.scrollTimer = null
    this.recordScroll()
  }

  private recordScroll(): void {
    this.send({
      messageType: 'pageEvent',
      event_type: 'scroll',
      url: location.href,
      title: document.title,
      timestamp: Date.now(),
      scroll_position: scrollPosition(),
    })
  }

  private send(message: PageEventMessage): void {
    chrome.runtime.sendMessage(message).catch((error: unknown) => {
      console.debug('[rex-page-events] sendMessage failed', error)
    })
  }
}

const plugin = new REXPageEventsModule()

registerREXModule(plugin)

export default plugin
