import { type REXConfiguration } from '@bric/rex-core/common'
import rexCorePlugin, {
  REXServiceWorkerModule,
  registerREXModule,
  dispatchEvent,
} from '@bric/rex-core/service-worker'
import { type RexPageUrlActiveEvent } from '@bric/rex-types/types'

import { type TabState, loadTabState, newTabState, saveTabState } from './tab-state.mjs'
import { deliverUrlActive, subscribeUrlActive } from './url-active.mjs'
import {
  type ClickMessage,
  type PageEventMessage,
  type PageEventType,
  type REXPageEventsConfiguration,
} from './types.mjs'

const EVENT_NAME = 'rex-page-event'
const URL_ACTIVE_EVENT_NAME = 'rex-page-url-active' as const
const LOG_PREFIX = '[rex-page-events]'
const CONFIGURATION_TIMEOUT_MS = 10000
const SLOW_HANDLER_WARNING_MS = 10000

const DEFAULT_EVENT_TYPES: Record<PageEventType, boolean> = {
  page_show: true,
  page_hide: true,
  load: true,
  scroll: true,
  tab_open: true,
  tab_url_change: true,
  tab_focus: true,
  tab_blur: true,
  tab_close: true,
  window_close: true,
  click: true,
}

interface EmittedRecord {
  eventType: PageEventType
  state: TabState
  tabId?: number
  url: string
  title?: string
  dateMs: number
  extras?: Record<string, unknown>
  urlShownAtMs?: number
}

export { type UrlActiveListener, subscribeUrlActive } from './url-active.mjs'

// @ts-expect-error: __rexPageEventsUrlActive is not defined on the service worker's global object
self.__rexPageEventsUrlActive = { subscribe: subscribeUrlActive }

function shownAtMsOfPage(state: TabState, pageUrl: string): number {
  if (state.previousUrlShownAtMs !== null && pageUrl === state.previousUrl) {
    return state.previousUrlShownAtMs
  }

  return state.currentUrlShownAtMs
}

function urlActiveRecordOf(state: TabState, tabId: number, url: string, urlShownAtMs: number): RexPageUrlActiveEvent {
  return {
    name: URL_ACTIVE_EVENT_NAME,
    tab_id: tabId,
    window_id: state.windowId,
    session_id: state.sessionId,
    url,
    url_shown_at: urlShownAtMs,
  }
}

function tabStateWithoutTab(sessionId: string, windowId: number, shownAtMs: number): TabState {
  return newTabState({ sessionId, windowId, shownAtMs, focused: false, url: '', title: '' })
}

class REXPageEventsServiceWorkerModule extends REXServiceWorkerModule {
  config: REXPageEventsConfiguration | null = null
  tabState: Map<number, TabState> = new Map()
  listenersRegistered: boolean = false
  handlerQueue: Promise<void> = Promise.resolve()

  moduleName() {
    return 'PageEventsModule'
  }

  setup() {
    this.refreshConfiguration()

    this.handlerQueue = Promise.all([this.loadSavedTabState(), this.loadStoredConfiguration()])
      .then(() => undefined)
    this.registerChromeListeners()
  }

  private enqueue(handler: () => Promise<void>) {
    this.handlerQueue = this.handlerQueue
      .then(() => this.runWarningWhenSlow(handler))
      .catch((error: unknown) => {
        console.warn(`${LOG_PREFIX} handler failed`, error)
      })
  }

  private runWarningWhenSlow(handler: () => Promise<void>): Promise<void> {
    const slowWarning = self.setTimeout(() => {
      console.warn(`${LOG_PREFIX} handler still running after ${SLOW_HANDLER_WARNING_MS} ms`)
    }, SLOW_HANDLER_WARNING_MS)

    return handler()
      .finally(() => {
        self.clearTimeout(slowWarning)
      })
  }

  private loadStoredConfiguration(): Promise<void> {
    return rexCorePlugin.fetchConfiguration()
      .then((configuration: REXConfiguration) => {
        this.applyConfiguration(configuration)
      })
      .catch((error: unknown) => {
        console.debug(`${LOG_PREFIX} could not read stored configuration`, error)
      })
  }

  refreshConfiguration() {
    rexCorePlugin.handleMessage({
      messageType: 'waitForConfiguration',
      event: { timeout: CONFIGURATION_TIMEOUT_MS }
    }, null, (configuration: REXConfiguration) => {
      this.applyConfiguration(configuration)
    })
  }

  private applyConfiguration(configuration: REXConfiguration | undefined) {
    const pageEventsConfig = configuration?.['page_events'] as REXPageEventsConfiguration | undefined

    if (pageEventsConfig !== undefined) {
      this.config = pageEventsConfig
    }
  }

  handleMessage(
    message: PageEventMessage | ClickMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void
  ): boolean {
    if (message.messageType === 'pageClick') {
      this.enqueue(() => this.recordClick(message, sender))
      sendResponse({ success: true })
      return true
    }
    if (message.messageType === 'pageEvent') {
      this.enqueue(() => this.recordPageEvent(message, sender))
      sendResponse({ success: true })
      return true
    }
    return false
  }

  private registerChromeListeners() {
    if (this.listenersRegistered) {
      return
    }
    this.listenersRegistered = true

    chrome.tabs.onCreated.addListener((tab) => {
      this.enqueue(() => this.onTabCreated(tab))
    })

    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (changeInfo.url !== undefined) {
        const url = changeInfo.url

        this.enqueue(() => this.onTabUrlChanged(tabId, url, tab))
      }
    })

    chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
      this.enqueue(() => this.onTabRemoved(tabId, removeInfo))
    })

    chrome.tabs.onActivated.addListener((activeInfo) => {
      this.enqueue(() => this.onTabActivated(activeInfo.tabId, activeInfo.windowId))
    })

    chrome.windows.onRemoved.addListener((windowId) => {
      this.enqueue(() => this.onWindowRemoved(windowId))
    })

    chrome.windows.onFocusChanged.addListener((windowId) => {
      this.enqueue(() => this.onWindowFocusChanged(windowId))
    })
  }

  private async onTabCreated(tab: chrome.tabs.Tab) {
    if (!this.isEnabled() || tab.id === undefined) {
      return
    }
    const nowMs = Date.now()
    const url = tab.url || tab.pendingUrl || ''
    const title = tab.title || ''

    const state = newTabState({
      sessionId: crypto.randomUUID(),
      windowId: tab.windowId,
      shownAtMs: nowMs,
      focused: tab.active,
      url,
      title,
    })
    this.tabState.set(tab.id, state)

    const extras: Record<string, unknown> = {}
    if (tab.openerTabId !== undefined) {
      extras.opener_tab_id = tab.openerTabId
      const openerState = this.tabState.get(tab.openerTabId)
      if (openerState !== undefined && openerState.currentUrl !== '') {
        extras.opener_url = openerState.currentUrl
      }
    }

    await this.emit({ eventType: 'tab_open', state, tabId: tab.id, url, title, dateMs: nowMs, extras })
    deliverUrlActive(urlActiveRecordOf(state, tab.id, url, nowMs))

    await this.storeTabState()
  }

  private async onTabUrlChanged(tabId: number, newUrl: string, tab: chrome.tabs.Tab) {
    if (!this.isEnabled()) {
      return
    }
    const nowMs = Date.now()
    const state = this.tabState.get(tabId) ?? this.backfillTabState(tabId, tab, nowMs)

    if (state.lastFocusAtMs !== null) {
      const focusFragment = nowMs - state.lastFocusAtMs
      state.focusDurationMs += focusFragment
      state.currentUrlFocusMs += focusFragment
      state.lastFocusAtMs = nowMs
    }

    const outgoingUrl = state.currentUrl
    const outgoingTitle = state.lastTitle
    const urlFocusDurationMs = state.currentUrlFocusMs
    const urlDwellMs = nowMs - state.currentUrlShownAtMs

    await this.emit({
      eventType: 'tab_url_change',
      state,
      tabId,
      url: outgoingUrl,
      title: outgoingTitle,
      dateMs: nowMs,
      extras: {
        url_focus_duration_ms: urlFocusDurationMs,
        url_dwell_ms: urlDwellMs,
        previous_url: state.previousUrl ?? undefined,
      },
      urlShownAtMs: state.currentUrlShownAtMs,
    })

    state.previousUrl = outgoingUrl
    state.previousUrlShownAtMs = state.currentUrlShownAtMs
    state.currentUrl = newUrl
    state.currentUrlShownAtMs = nowMs
    state.currentUrlFocusMs = 0
    state.lastTitle = tab.title || ''

    deliverUrlActive(urlActiveRecordOf(state, tabId, newUrl, nowMs))

    await this.storeTabState()
  }

  private async onTabRemoved(tabId: number, removeInfo: { windowId: number; isWindowClosing: boolean }) {
    if (!this.isEnabled()) {
      this.tabState.delete(tabId)
      await this.storeTabState()
      return
    }
    const nowMs = Date.now()
    const state = this.tabState.get(tabId)
    if (state === undefined) {
      return
    }

    if (state.lastFocusAtMs !== null) {
      const fragment = nowMs - state.lastFocusAtMs
      state.focusDurationMs += fragment
      state.currentUrlFocusMs += fragment
      state.lastFocusAtMs = null
    }

    const tabLifetimeMs = nowMs - state.openedAtMs
    const urlDwellMs = nowMs - state.currentUrlShownAtMs

    await this.emit({
      eventType: 'tab_close',
      state,
      tabId,
      url: state.currentUrl,
      title: state.lastTitle,
      dateMs: nowMs,
      extras: {
        tab_lifetime_ms: tabLifetimeMs,
        focus_duration_ms: state.focusDurationMs,
        url_focus_duration_ms: state.currentUrlFocusMs,
        url_dwell_ms: urlDwellMs,
        is_window_closing: removeInfo.isWindowClosing,
      },
    })

    this.tabState.delete(tabId)
    await this.storeTabState()
  }

  private async onTabActivated(tabId: number, windowId: number) {
    if (!this.isEnabled()) {
      return
    }
    const nowMs = Date.now()

    for (const [otherTabId, otherState] of this.tabState.entries()) {
      if (otherTabId !== tabId && otherState.windowId === windowId && otherState.lastFocusAtMs !== null) {
        const fragment = nowMs - otherState.lastFocusAtMs
        otherState.focusDurationMs += fragment
        otherState.currentUrlFocusMs += fragment
        otherState.lastFocusAtMs = null
        await this.emit({ eventType: 'tab_blur', state: otherState, tabId: otherTabId, url: otherState.currentUrl, title: otherState.lastTitle, dateMs: nowMs })
      }
    }

    const state = this.tabState.get(tabId)
    if (state !== undefined && state.lastFocusAtMs === null) {
      state.lastFocusAtMs = nowMs
      await this.emit({ eventType: 'tab_focus', state, tabId, url: state.currentUrl, title: state.lastTitle, dateMs: nowMs })
    }

    await this.storeTabState()
  }

  private async onWindowFocusChanged(windowId: number) {
    if (!this.isEnabled()) {
      return
    }
    const nowMs = Date.now()
    const windowLost = windowId === chrome.windows.WINDOW_ID_NONE

    for (const [tabId, state] of this.tabState.entries()) {
      if (state.lastFocusAtMs !== null && (windowLost || state.windowId !== windowId)) {
        const fragment = nowMs - state.lastFocusAtMs
        state.focusDurationMs += fragment
        state.currentUrlFocusMs += fragment
        state.lastFocusAtMs = null
        await this.emit({ eventType: 'tab_blur', state, tabId, url: state.currentUrl, title: state.lastTitle, dateMs: nowMs })
      }
    }

    if (windowLost === false) {
      const [activeTab] = await chrome.tabs.query({ active: true, windowId })
      const state = activeTab?.id === undefined ? undefined : this.tabState.get(activeTab.id)

      if (activeTab?.id !== undefined && state !== undefined && state.lastFocusAtMs === null) {
        state.lastFocusAtMs = nowMs
        await this.emit({ eventType: 'tab_focus', state, tabId: activeTab.id, url: state.currentUrl, title: state.lastTitle, dateMs: nowMs })
      }
    }

    await this.storeTabState()
  }

  private async onWindowRemoved(windowId: number) {
    if (!this.isEnabled()) {
      return
    }
    const nowMs = Date.now()
    const synthetic = tabStateWithoutTab(crypto.randomUUID(), windowId, nowMs)
    await this.emit({ eventType: 'window_close', state: synthetic, url: '', title: '', dateMs: nowMs, extras: { window_id: windowId } })
  }

  private async recordPageEvent(
    message: PageEventMessage,
    sender: chrome.runtime.MessageSender
  ) {
    if (!this.isEnabled() || !message.event_type || sender.tab?.id === undefined) {
      return
    }
    const tabId = sender.tab.id
    const nowMs = typeof message.timestamp === 'number' ? message.timestamp : Date.now()
    const url = message.url ?? sender.tab.url ?? ''
    const title = message.title ?? sender.tab.title ?? ''

    const state = this.tabState.get(tabId) ?? this.backfillTabState(tabId, sender.tab, nowMs)

    state.lastTitle = title

    const extras: Record<string, unknown> = {}
    if (typeof message.persisted === 'boolean') {
      extras.persisted = message.persisted
    }

    if (message.scroll_position !== undefined) {
      extras.scroll_position = message.scroll_position
    }

    await this.emit({ eventType: message.event_type, state, tabId, url, title, dateMs: nowMs, extras })

    await this.storeTabState()
  }

  private async recordClick(message: ClickMessage, sender: chrome.runtime.MessageSender) {
    if (!this.isEnabled() || sender.tab?.id === undefined) {
      return
    }
    const tabId = sender.tab.id
    const dateMs = typeof message.timestamp === 'number' ? message.timestamp : Date.now()
    const url = message.url ?? sender.tab.url ?? ''
    const title = message.title ?? sender.tab.title ?? ''
    const state = this.tabState.get(tabId) ?? this.backfillTabState(tabId, sender.tab, dateMs)
    const pageShownAtMs = shownAtMsOfPage(state, url)

    state.lastTitle = title

    await this.emit({
      eventType: 'click',
      state,
      tabId,
      url,
      title,
      dateMs,
      extras: clickExtrasOf(message),
      urlShownAtMs: pageShownAtMs,
    })

    await this.storeTabState()
  }

  private async emit(record: EmittedRecord) {
    const { eventType, state, tabId, url, title, dateMs, extras = {}, urlShownAtMs } = record

    if (!this.isEventTypeOn(eventType)) {
      return
    }

    const payload: Record<string, unknown> = {
      name: EVENT_NAME,
      event_type: eventType,
      session_id: state.sessionId,
      window_id: state.windowId,
      url,
      url_shown_at: urlShownAtMs ?? state.currentUrlShownAtMs,
      date: dateMs,
    }
    if (tabId !== undefined) {
      payload.tab_id = tabId
    }
    if (title !== undefined) {
      payload.title = title
    }
    for (const [k, v] of Object.entries(extras)) {
      if (v !== undefined) {
        payload[k] = v
      }
    }

    dispatchEvent(payload as { name: string } & Record<string, unknown>)
  }

  private isEnabled(): boolean {
    return this.config !== null && this.config.enabled === true
  }

  private isEventTypeOn(eventType: PageEventType): boolean {
    const configured = this.config?.event_types?.[eventType]
    return typeof configured === 'boolean' ? configured : DEFAULT_EVENT_TYPES[eventType]
  }

  private storeTabState(): Promise<void> {
    return saveTabState(this.tabState)
      .catch((error: unknown) => {
        console.debug(`${LOG_PREFIX} could not save tab state`, error)
      })
  }

  private loadSavedTabState(): Promise<void> {
    return loadTabState()
      .then((saved) => {
        if (saved !== null) {
          this.tabState = saved
        }
      })
      .catch((error: unknown) => {
        console.debug(`${LOG_PREFIX} could not load saved tab state`, error)
      })
  }

  private backfillTabState(tabId: number, tab: chrome.tabs.Tab | undefined, nowMs: number): TabState {
    const state = newTabState({
      sessionId: crypto.randomUUID(),
      windowId: tab?.windowId ?? -1,
      shownAtMs: nowMs,
      focused: tab?.active === true,
      url: tab?.url ?? '',
      title: tab?.title ?? '',
    })
    this.tabState.set(tabId, state)
    return state
  }
}

function clickExtrasOf(message: ClickMessage): Record<string, unknown> {
  return {
    click_id: message.click_id,
    click_type: message.click_type,
    button: message.button,
    modifier_keys: message.modifier_keys,
    click_count: message.click_count,
    on_link: message.on_link,
    link_url: linkAddressOf(message),
    link_text: message.link_text,
    link_target: message.link_target,
    claimed: message.claim === undefined ? undefined : true,
  }
}

function linkAddressOf(message: ClickMessage): string | undefined {
  if (message.link_url === undefined) {
    return undefined
  }

  return message.claim?.destination_url ?? message.link_url
}

const plugin = new REXPageEventsServiceWorkerModule()

registerREXModule(plugin)

export default plugin
