import { REXClientModule, registerREXModule } from '@bric/rex-core/browser'

import { type PageEventMessage, type REXPageEventsConfiguration, type ScrollPosition } from './types.mjs'

const DEFAULT_SCROLL_PAUSE_MS = 250
const CONFIGURATION_TIMEOUT_MS = 10000

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

function waitForConfiguration(): Promise<Record<string, unknown> | undefined> {
  return chrome.runtime.sendMessage({ messageType: 'waitForConfiguration', event: { timeout: CONFIGURATION_TIMEOUT_MS } })
}

function readScrollPauseMs(configuration: Record<string, unknown> | undefined): number {
  const pageEvents = configuration?.page_events as REXPageEventsConfiguration | undefined
  const pauseMs = pageEvents?.scroll_pause_delay

  if (typeof pauseMs === 'number' && Number.isFinite(pauseMs) && pauseMs > 0) {
    return pauseMs
  }

  return DEFAULT_SCROLL_PAUSE_MS
}

class REXPageEventsModule extends REXClientModule {
  private scrollTimer: ReturnType<typeof setTimeout> | null = null
  private scrollPauseMs: number | null = null
  toString(): string {
    return 'REXPageEventsModule'
  }

  setup() {
    console.log('[rex-page-events] browser setup')

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

    waitForConfiguration()
      .then((configuration) => {
        this.scrollPauseMs = readScrollPauseMs(configuration)
        this.recordLoad()
        this.recordScroll()
      })
      .catch((error: unknown) => {
        console.debug('[rex-page-events] no configuration', error)
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
    window.addEventListener('scroll', () => {
      if (this.scrollPauseMs !== null) {
        this.scheduleScroll(this.scrollPauseMs)
      }
    })

    window.addEventListener('pagehide', () => {
      this.flushScroll()
    })

    window.addEventListener('pageshow', (event: PageTransitionEvent) => {
      if (event.persisted === true && this.scrollPauseMs !== null) {
        this.recordScroll()
      }
    })
  }

  private scheduleScroll(pauseMs: number): void {
    if (this.scrollTimer !== null) {
      clearTimeout(this.scrollTimer)
    }

    this.scrollTimer = setTimeout(() => {
      this.scrollTimer = null
      this.recordScroll()
    }, pauseMs)
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
