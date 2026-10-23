import { REXClientModule, registerREXModule } from '@bric/rex-core/browser'

type BrowserEventType = 'page_show' | 'page_hide' | 'tab_focus' | 'tab_blur' | 'load' | 'scroll'

interface ScrollPosition {
  top: number
  left: number
  width: number
  height: number
  document_height: number
}

interface PageEventMessage {
  messageType: 'pageEvent'
  event_type: BrowserEventType
  url: string
  title: string
  timestamp: number
  persisted?: boolean
  top?: number
  left?: number
  width?: number
  height?: number
  document_height?: number
}

const SCROLL_PAUSE_MS = 250

function loadStartTime(): number {
  const [navigation] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[]

  return performance.timeOrigin + navigation.loadEventStart
}

function scrollPosition(): ScrollPosition {
  return {
    top: window.scrollY,
    left: window.scrollX,
    width: document.documentElement.clientWidth,
    height: document.documentElement.clientHeight,
    document_height: document.documentElement.scrollHeight,
  }
}

class REXPageEventsModule extends REXClientModule {
  private scrollTimer: ReturnType<typeof setTimeout> | undefined
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
    clearTimeout(this.scrollTimer)

    this.scrollTimer = setTimeout(() => {
      this.scrollTimer = undefined
      this.recordScroll()
    }, SCROLL_PAUSE_MS)
  }

  private flushScroll(): void {
    if (this.scrollTimer === undefined) {
      return
    }

    clearTimeout(this.scrollTimer)
    this.scrollTimer = undefined
    this.recordScroll()
  }

  private recordScroll(): void {
    this.send({
      messageType: 'pageEvent',
      event_type: 'scroll',
      url: location.href,
      title: document.title,
      timestamp: Date.now(),
      ...scrollPosition(),
    })
  }

  private send(message: PageEventMessage): void {
    try {
      const result = chrome.runtime.sendMessage(message)
      if (result && typeof (result as Promise<unknown>).catch === 'function') {
        ;(result as Promise<unknown>).catch((err: unknown) => {
          console.debug('[rex-page-events] sendMessage failed', err)
        })
      }
    } catch (err) {
      console.debug('[rex-page-events] sendMessage threw', err)
    }
  }
}

const plugin = new REXPageEventsModule()

registerREXModule(plugin)

export default plugin
