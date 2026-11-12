import { type REXConfiguration } from '@bric/rex-core/common'
import rexCorePlugin, {
  REXServiceWorkerModule,
  registerREXModule,
  dispatchEvent,
} from '@bric/rex-core/service-worker'
import { matchDomainAgainstList } from '@bric/rex-lists'
import { type RexPageUrlActiveEvent } from '@bric/rex-types/types'

import {
  type ClickLinkFields,
  type FilterListLookup,
  type LinkRedaction,
  claimsRevealingOrigin,
  clickLinkFieldsFor,
  hiddenLinkModeOf,
  revealsOrigin,
} from './hidden-link-mode.mjs'
import { type TabState, loadTabState, newTabState, saveTabState } from './tab-state.mjs'
import { deliverUrlActive, subscribeUrlActive } from './url-active.mjs'
import {
  type ClickMessage,
  type HiddenLinkMode,
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

interface RedactionResult {
  url: string
  title?: string
  filtered: boolean
  filtered_by_list?: string
  allowed_by_list?: string
}

export { type UrlActiveListener, subscribeUrlActive } from './url-active.mjs'

// @ts-expect-error: __rexPageEventsUrlActive is not defined on the service worker's global object
self.__rexPageEventsUrlActive = { subscribe: subscribeUrlActive }

function extractHostname(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

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
        const openerRedaction = await this.redact(openerState.currentUrl, '')
        extras.opener_url = openerRedaction.url
        extras.opener_filtered = openerRedaction.filtered
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

    let previousUrlRedacted: string | undefined
    let previousUrlFiltered: boolean | undefined
    if (state.previousUrl !== null) {
      const priorRedaction = await this.redact(state.previousUrl, '')
      previousUrlRedacted = priorRedaction.url
      previousUrlFiltered = priorRedaction.filtered
    }

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
        previous_url: previousUrlRedacted,
        previous_url_filtered: previousUrlFiltered,
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
      extras: await this.clickExtras(message, url),
      urlShownAtMs: pageShownAtMs,
    })

    await this.storeTabState()
  }

  private async clickExtras(message: ClickMessage, pageUrl: string): Promise<Record<string, unknown>> {
    const pageHidden = (await this.redact(pageUrl, message.title)).filtered
    const linkFields = pageHidden ? await this.hiddenPageLinkFields(message) : await this.allowedPageLinkFields(message, pageUrl)

    return {
      click_id: message.click_id,
      click_type: message.click_type,
      button: message.button,
      modifier_keys: message.modifier_keys,
      click_count: message.click_count,
      on_link: message.on_link,
      ...linkFields,
      link_target: message.link_target,
      claimed: message.claim === undefined ? undefined : true,
    }
  }

  private async hiddenPageLinkFields(message: ClickMessage): Promise<Partial<ClickLinkFields>> {
    const address = linkAddressOf(message)

    if (address === undefined) {
      return {}
    }

    return { link_url: (await this.redact(address, '')).url }
  }

  private async allowedPageLinkFields(message: ClickMessage, pageUrl: string): Promise<Partial<ClickLinkFields>> {
    const address = linkAddressOf(message)

    if (address === undefined) {
      return { link_text: message.link_text }
    }

    const mayRevealOrigin = claimsRevealingOrigin(message.claim !== undefined, address, pageUrl)
    const redaction = await this.redact(address, '')
    const mode = this.hiddenLinkMode()
    const filterLookup = await this.filterLookupFor(mode, mayRevealOrigin, redaction, address)

    return clickLinkFieldsFor(mode, mayRevealOrigin, redaction, address, message.link_text, filterLookup)
  }

  private hiddenLinkMode(): HiddenLinkMode {
    return hiddenLinkModeOf(this.config?.hidden_link_mode, false)
  }

  private filterLookupFor(
    mode: HiddenLinkMode,
    claimed: boolean,
    redaction: LinkRedaction,
    address: string
  ): Promise<FilterListLookup | null> {
    return revealsOrigin(mode, claimed, redaction) ? this.lookUpFilterLists(address) : Promise.resolve(null)
  }

  private async emit(record: EmittedRecord) {
    const { eventType, state, tabId, url, title, dateMs, extras = {}, urlShownAtMs } = record

    if (!this.isEventTypeOn(eventType)) {
      return
    }

    const redaction = await this.redact(url, title ?? '')

    const payload: Record<string, unknown> = {
      name: EVENT_NAME,
      event_type: eventType,
      session_id: state.sessionId,
      window_id: state.windowId,
      url: redaction.url,
      url_shown_at: urlShownAtMs ?? state.currentUrlShownAtMs,
      date: dateMs,
      filtered: redaction.filtered,
    }
    if (tabId !== undefined) {
      payload.tab_id = tabId
    }
    if (title !== undefined && redaction.title !== undefined) {
      payload.title = redaction.title
    }
    if (redaction.filtered_by_list !== undefined) {
      payload.filtered_by_list = redaction.filtered_by_list
    }
    if (redaction.allowed_by_list !== undefined) {
      payload.allowed_by_list = redaction.allowed_by_list
    }
    for (const [k, v] of Object.entries(extras)) {
      if (v !== undefined) {
        payload[k] = v
      }
    }

    dispatchEvent(payload as { name: string } & Record<string, unknown>)
  }

  private async redact(url: string, title: string): Promise<RedactionResult> {
    if (!url) {
      return { url, title, filtered: false }
    }

    const domainOnly = await this.applyDomainOnlyLists(url)
    if (domainOnly !== null) {
      return domainOnly
    }

    const { allowed, allowedBy } = await this.allowCheck(url)
    if (!allowed) {
      return {
        url: 'CATEGORY:NOT_ON_ALLOWLIST',
        filtered: true,
        filtered_by_list: 'NOT_ON_ALLOWLIST',
      }
    }
    const allowedByField = allowedBy ? { allowed_by_list: allowedBy } : {}

    const filtered = await this.applyFilterLists(url)
    if (filtered !== null) {
      return { ...filtered, ...allowedByField }
    }
    return { url, title, filtered: false, ...allowedByField }
  }

  private async isAllowedPage(url: string): Promise<boolean> {
    return (await this.allowCheck(url)).allowed
  }

  private async allowCheck(url: string): Promise<{ allowed: boolean; allowedBy?: string }> {
    if (this.config?.allow_all === true) {
      return { allowed: true }
    }

    const allowedBy = await this.findAllowList(url)

    return allowedBy === null ? { allowed: false } : { allowed: true, allowedBy }
  }

  private async findAllowList(url: string): Promise<string | null> {
    for (const listName of this.config?.allow_lists ?? []) {
      try {
        if (await matchDomainAgainstList(url, listName)) {
          return listName
        }
      } catch (err) {
        console.warn(`${LOG_PREFIX} allow list error on ${listName}`, err)
      }
    }
    return null
  }

  private async applyFilterLists(url: string): Promise<RedactionResult | null> {
    return (await this.lookUpFilterLists(url)).match
  }

  private async lookUpFilterLists(url: string): Promise<{ match: RedactionResult | null; failed: boolean }> {
    const lists = this.config?.filter_lists ?? []
    let failed = false
    for (const listName of lists) {
      try {
        const entry = await matchDomainAgainstList(url, listName)
        if (entry) {
          const category = (entry.metadata?.category as string | undefined) ?? null
          return {
            match: {
              url: `CATEGORY:${category ?? 'null'}`,
              filtered: true,
              filtered_by_list: listName,
            },
            failed,
          }
        }
      } catch (err) {
        console.warn(`${LOG_PREFIX} filter list error on ${listName}`, err)
        failed = true
      }
    }
    return { match: null, failed }
  }

  private async applyDomainOnlyLists(url: string): Promise<RedactionResult | null> {
    const lists = this.config?.domain_only_lists ?? []
    for (const listName of lists) {
      try {
        const entry = await matchDomainAgainstList(url, listName)
        if (entry) {
          const hostname = extractHostname(url)
          return {
            url: hostname,
            title: 'DOMAIN ONLY',
            filtered: true,
            filtered_by_list: listName,
          }
        }
      } catch (err) {
        console.warn(`${LOG_PREFIX} domain_only list error on ${listName}`, err)
      }
    }
    return null
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

function linkAddressOf(message: ClickMessage): string | undefined {
  if (message.link_url === undefined) {
    return undefined
  }

  return message.claim?.destination_url ?? message.link_url
}

const plugin = new REXPageEventsServiceWorkerModule()

registerREXModule(plugin)

export default plugin
