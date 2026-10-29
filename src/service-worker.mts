import { type REXConfiguration } from '@bric/rex-core/common'
import rexCorePlugin, {
  REXServiceWorkerModule,
  registerREXModule,
  dispatchEvent,
} from '@bric/rex-core/service-worker'
import { matchDomainAgainstList } from '@bric/rex-lists'
import { type RexPageUrlActiveEvent } from '@bric/rex-types/types'

import { type PageEventMessage, type PageEventType } from './types.mjs'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EVENT_NAME = 'rex-page-event'
const URL_ACTIVE_EVENT_NAME = 'rex-page-url-active' as const
const LOG_PREFIX = '[rex-page-events]'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PageEventsConfig {
  enabled: boolean
  filter_lists?: string[]
  allow_lists?: string[]
  domain_only_lists?: string[]
  debug?: boolean
}

interface TabState {
  sessionId: string
  windowId: number
  openedAtMs: number
  lastFocusAtMs: number | null
  focusDurationMs: number
  // Per-URL-segment accounting. `currentUrl` is the URL presently showing in the tab;
  // the segment resets on every tab_url_change (and mints fresh at tab_open).
  currentUrl: string
  currentUrlShownAtMs: number
  currentUrlFocusMs: number
  lastTitle: string
  // URL that preceded currentUrl in this tab, if any. Populated on tab_url_change
  // so the next tab_url_change can emit it as `previous_url` (two hops of history).
  priorUrl: string | null
}

interface RedactionResult {
  url: string
  title?: string
  filtered: boolean
  filtered_by_list?: string
  allowed_by_list?: string
}

export type UrlActiveListener = (event: RexPageUrlActiveEvent) => void

// ---------------------------------------------------------------------------
// Loose-coupling seam: sibling SW modules (e.g. rex-history) discover us here
// without taking a build-time dep. `subscribe` returns an unsubscribe function.
// ---------------------------------------------------------------------------

const urlActiveListeners: Set<UrlActiveListener> = new Set()

export function subscribeUrlActive(listener: UrlActiveListener): () => void {
  urlActiveListeners.add(listener)
  return () => {
    urlActiveListeners.delete(listener)
  }
}

interface UrlActiveSeam {
  subscribe: typeof subscribeUrlActive
}

;(globalThis as unknown as { __rexPageEventsUrlActive?: UrlActiveSeam })
  .__rexPageEventsUrlActive = { subscribe: subscribeUrlActive }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractHostname(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

function makeSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

class REXPageEventsServiceWorkerModule extends REXServiceWorkerModule {
  config: PageEventsConfig | null = null
  tabState: Map<number, TabState> = new Map()
  listenersRegistered: boolean = false

  moduleName() {
    return 'PageEventsModule'
  }

  setup() {
    this.registerChromeListeners()
    this.refreshConfiguration()
  }

  refreshConfiguration() {
    rexCorePlugin.fetchConfiguration()
      .then((configuration: REXConfiguration | undefined) => {
        if (configuration !== undefined) {
          const pageEventsConfig = configuration['page_events'] as PageEventsConfig | undefined

          if (pageEventsConfig !== undefined) {
            this.config = pageEventsConfig
            console.log(`${LOG_PREFIX} config loaded`, pageEventsConfig)
            return
          }
        }

        setTimeout(() => {
          this.refreshConfiguration()
        }, 1000)
      })
  }

  handleMessage(
    message: PageEventMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void
  ): boolean {
    if (message && message.messageType === 'pageEvent') {
      this.recordPageEvent(message, sender)
      sendResponse({ success: true })
      return true
    }
    return false
  }

  // -------------------------------------------------------------------------
  // Chrome listener registration
  // -------------------------------------------------------------------------

  private registerChromeListeners() {
    if (this.listenersRegistered) {
      return
    }
    this.listenersRegistered = true

    chrome.tabs.onCreated.addListener((tab) => {
      this.onTabCreated(tab)
    })

    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (changeInfo.url !== undefined) {
        this.onTabUrlChanged(tabId, changeInfo.url, tab)
      }
    })

    chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
      this.onTabRemoved(tabId, removeInfo)
    })

    chrome.tabs.onActivated.addListener((activeInfo) => {
      this.onTabActivated(activeInfo.tabId, activeInfo.windowId)
    })

    if (chrome.windows !== undefined) {
      if (chrome.windows.onRemoved !== undefined) {
        chrome.windows.onRemoved.addListener((windowId) => {
          this.onWindowRemoved(windowId)
        })
      }
      if (chrome.windows.onFocusChanged !== undefined) {
        chrome.windows.onFocusChanged.addListener((windowId) => {
          this.onWindowFocusChanged(windowId)
        })
      }
    }
  }

  // -------------------------------------------------------------------------
  // Event handlers
  // -------------------------------------------------------------------------

  private async onTabCreated(tab: chrome.tabs.Tab) {
    if (!this.isEnabled() || tab.id === undefined) {
      return
    }
    const now = Date.now()
    const url = tab.url || tab.pendingUrl || ''
    const title = tab.title || ''

    const state: TabState = {
      sessionId: makeSessionId(),
      windowId: tab.windowId,
      openedAtMs: now,
      lastFocusAtMs: tab.active ? now : null,
      focusDurationMs: 0,
      currentUrl: url,
      currentUrlShownAtMs: now,
      currentUrlFocusMs: 0,
      lastTitle: title,
      priorUrl: null,
    }
    this.tabState.set(tab.id, state)

    // If this tab was opened from another tab (middle-click, target=_blank,
    // window.open, etc.), Chrome sets openerTabId. Surface the opener's current
    // URL so downstream can reconstruct cross-tab referral chains. Redacted
    // with the same rules as `url`.
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

    await this.emit('tab_open', state, tab.id, url, title, now, extras)
    // After emitting tab_open, announce the URL-active record so sibling modules
    // (e.g. rex-history) can link. Raw URL on purpose — redaction happens only on
    // the outbound event bus.
    this.deliverUrlActive(state, tab.id, url, now)
  }

  private async onTabUrlChanged(tabId: number, newUrl: string, tab: chrome.tabs.Tab) {
    if (!this.isEnabled()) {
      return
    }
    const now = Date.now()
    const state = this.tabState.get(tabId) ?? this.backfillTabState(tabId, tab, now)

    // Flush the outgoing segment. If the tab is currently focused, add the open
    // focus fragment to the segment counter first so url_focus_duration_ms is accurate.
    if (state.lastFocusAtMs !== null) {
      const focusFragment = now - state.lastFocusAtMs
      state.focusDurationMs += focusFragment
      state.currentUrlFocusMs += focusFragment
      // Re-arm lastFocusAtMs so the new segment gets credit for ongoing focus.
      state.lastFocusAtMs = now
    }

    const outgoingUrl = state.currentUrl
    const outgoingTitle = state.lastTitle
    const urlFocusDurationMs = state.currentUrlFocusMs
    const urlDwellMs = now - state.currentUrlShownAtMs

    // Redact previous_url with the same rules as url so privacy is consistent.
    let previousUrlRedacted: string | undefined
    let previousUrlFiltered: boolean | undefined
    if (state.priorUrl !== null) {
      const priorRedaction = await this.redact(state.priorUrl, '')
      previousUrlRedacted = priorRedaction.url
      previousUrlFiltered = priorRedaction.filtered
    }

    // Emit the segment-close event. Payload describes the OUTGOING URL; url_shown_at
    // is the outgoing segment's start. `previous_url` is the URL that preceded the
    // outgoing one in this tab (two hops of history), if any.
    await this.emit(
      'tab_url_change',
      state,
      tabId,
      outgoingUrl,
      outgoingTitle,
      now,
      {
        url_focus_duration_ms: urlFocusDurationMs,
        url_dwell_ms: urlDwellMs,
        previous_url: previousUrlRedacted,
        previous_url_filtered: previousUrlFiltered,
      },
      state.currentUrlShownAtMs
    )

    // Reset segment state for the new URL.
    state.priorUrl = outgoingUrl
    state.currentUrl = newUrl
    state.currentUrlShownAtMs = now
    state.currentUrlFocusMs = 0
    state.lastTitle = tab.title || ''

    // Announce the new URL so sibling modules can link.
    this.deliverUrlActive(state, tabId, newUrl, now)
  }

  private async onTabRemoved(tabId: number, removeInfo: { windowId: number; isWindowClosing: boolean }) {
    if (!this.isEnabled()) {
      this.tabState.delete(tabId)
      return
    }
    const now = Date.now()
    const state = this.tabState.get(tabId)
    if (state === undefined) {
      return
    }

    // Finalize focus: if currently focused, close the fragment into BOTH counters.
    if (state.lastFocusAtMs !== null) {
      const fragment = now - state.lastFocusAtMs
      state.focusDurationMs += fragment
      state.currentUrlFocusMs += fragment
      state.lastFocusAtMs = null
    }

    const tabLifetimeMs = now - state.openedAtMs
    const urlDwellMs = now - state.currentUrlShownAtMs

    await this.emit(
      'tab_close',
      state,
      tabId,
      state.currentUrl,
      state.lastTitle,
      now,
      {
        tab_lifetime_ms: tabLifetimeMs,
        focus_duration_ms: state.focusDurationMs,
        url_focus_duration_ms: state.currentUrlFocusMs,
        url_dwell_ms: urlDwellMs,
        is_window_closing: removeInfo.isWindowClosing,
      }
    )

    this.tabState.delete(tabId)
  }

  private async onTabActivated(tabId: number, windowId: number) {
    if (!this.isEnabled()) {
      return
    }
    const now = Date.now()

    // Blur every other tab in the same window that was focused.
    for (const [otherTabId, otherState] of this.tabState.entries()) {
      if (otherTabId !== tabId && otherState.windowId === windowId && otherState.lastFocusAtMs !== null) {
        const fragment = now - otherState.lastFocusAtMs
        otherState.focusDurationMs += fragment
        otherState.currentUrlFocusMs += fragment
        otherState.lastFocusAtMs = null
        await this.emit('tab_blur', otherState, otherTabId, otherState.currentUrl, otherState.lastTitle, now)
      }
    }

    const state = this.tabState.get(tabId)
    if (state === undefined) {
      return
    }
    if (state.lastFocusAtMs === null) {
      state.lastFocusAtMs = now
      await this.emit('tab_focus', state, tabId, state.currentUrl, state.lastTitle, now)
    }
  }

  private async onWindowFocusChanged(windowId: number) {
    if (!this.isEnabled()) {
      return
    }
    const now = Date.now()
    const windowLost = windowId === chrome.windows.WINDOW_ID_NONE

    if (windowLost) {
      // Blur every focused tab.
      for (const [tabId, state] of this.tabState.entries()) {
        if (state.lastFocusAtMs !== null) {
          const fragment = now - state.lastFocusAtMs
          state.focusDurationMs += fragment
          state.currentUrlFocusMs += fragment
          state.lastFocusAtMs = null
          await this.emit('tab_blur', state, tabId, state.currentUrl, state.lastTitle, now)
        }
      }
    }
  }

  private async onWindowRemoved(windowId: number) {
    if (!this.isEnabled()) {
      return
    }
    const now = Date.now()
    // window_close is window-level; no tab context.
    const synthetic: TabState = {
      sessionId: makeSessionId(),
      windowId: windowId,
      openedAtMs: now,
      lastFocusAtMs: null,
      focusDurationMs: 0,
      currentUrl: '',
      currentUrlShownAtMs: now,
      currentUrlFocusMs: 0,
      lastTitle: '',
      priorUrl: null,
    }
    await this.emit('window_close', synthetic, undefined, '', '', now, { window_id: windowId })
  }

  private async recordPageEvent(
    message: PageEventMessage,
    sender: chrome.runtime.MessageSender
  ) {
    if (!this.isEnabled() || !message.event_type || sender.tab?.id === undefined) {
      return
    }
    const tabId = sender.tab.id
    const now = typeof message.timestamp === 'number' ? message.timestamp : Date.now()
    const url = message.url ?? sender.tab.url ?? ''
    const title = message.title ?? sender.tab.title ?? ''

    const state = this.tabState.get(tabId) ?? this.backfillTabState(tabId, sender.tab, now)

    // Content-script events describe the CURRENT URL. If the URL the page reports
    // differs from the tab-state's currentUrl (rare but possible on very fast
    // same-document navigations or SPA fragment changes), leave the tab state
    // untouched — the authoritative URL source is chrome.tabs.onUpdated.
    state.lastTitle = title

    const extras: Record<string, unknown> = {}
    if (typeof message.persisted === 'boolean') {
      extras.persisted = message.persisted
    }

    if (message.scroll_position !== undefined) {
      extras.scroll_position = message.scroll_position
    }

    await this.emit(message.event_type, state, tabId, url, title, now, extras)
  }

  // -------------------------------------------------------------------------
  // Emission + redaction
  // -------------------------------------------------------------------------

  private async emit(
    eventType: PageEventType,
    state: TabState,
    tabId: number | undefined,
    url: string,
    title: string,
    timestamp: number,
    extras: Record<string, unknown> = {},
    urlShownAtOverrideMs?: number
  ) {
    const redaction = await this.redact(url, title)

    const payload: Record<string, unknown> = {
      name: EVENT_NAME,
      event_type: eventType,
      session_id: state.sessionId,
      window_id: state.windowId,
      url: redaction.url,
      url_shown_at: urlShownAtOverrideMs ?? state.currentUrlShownAtMs,
      timestamp,
      date: timestamp,
      filtered: redaction.filtered,
    }
    if (tabId !== undefined) {
      payload.tab_id = tabId
    }
    if (redaction.title !== undefined) {
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

  private deliverUrlActive(
    state: TabState,
    tabId: number,
    url: string,
    urlShownAtMs: number
  ) {
    const record: RexPageUrlActiveEvent = {
      name: URL_ACTIVE_EVENT_NAME,
      tab_id: tabId,
      window_id: state.windowId,
      session_id: state.sessionId,
      url,
      url_shown_at: urlShownAtMs,
    }

    // Always deliver to in-process subscribers.
    for (const listener of urlActiveListeners) {
      try {
        listener(record)
      } catch (err) {
        console.warn(`${LOG_PREFIX} url-active listener threw`, err)
      }
    }

    // In debug mode, also publish to the event bus so PDK/local-download can log it.
    if (this.config?.debug === true) {
      dispatchEvent(record as unknown as { name: string } & Record<string, unknown>)
    }
  }

  private async redact(url: string, title: string): Promise<RedactionResult> {
    const cfg = this.config
    if (!url) {
      return { url, title, filtered: false }
    }

    // 1. Allow-lists
    const allowLists = cfg?.allow_lists ?? []
    if (allowLists.length > 0) {
      let matched: { list: string } | null = null
      for (const listName of allowLists) {
        try {
          const entry = await matchDomainAgainstList(url, listName)
          if (entry) {
            matched = { list: listName }
            break
          }
        } catch (err) {
          console.warn(`${LOG_PREFIX} allow list error on ${listName}`, err)
        }
      }
      if (matched === null) {
        return {
          url: 'CATEGORY:NOT_ON_ALLOWLIST',
          filtered: true,
          filtered_by_list: 'NOT_ON_ALLOWLIST',
        }
      }
      const allowedBy = matched.list

      const filtered = await this.applyFilterLists(url)
      if (filtered !== null) {
        return { ...filtered, allowed_by_list: allowedBy }
      }
      const domainOnly = await this.applyDomainOnlyLists(url)
      if (domainOnly !== null) {
        return { ...domainOnly, allowed_by_list: allowedBy }
      }
      return { url, title, filtered: false, allowed_by_list: allowedBy }
    }

    const filtered = await this.applyFilterLists(url)
    if (filtered !== null) {
      return filtered
    }
    const domainOnly = await this.applyDomainOnlyLists(url)
    if (domainOnly !== null) {
      return domainOnly
    }
    return { url, title, filtered: false }
  }

  private async applyFilterLists(url: string): Promise<RedactionResult | null> {
    const lists = this.config?.filter_lists ?? []
    for (const listName of lists) {
      try {
        const entry = await matchDomainAgainstList(url, listName)
        if (entry) {
          const category = (entry.metadata?.category as string | undefined) ?? null
          return {
            url: `CATEGORY:${category ?? 'null'}`,
            filtered: true,
            filtered_by_list: listName,
          }
        }
      } catch (err) {
        console.warn(`${LOG_PREFIX} filter list error on ${listName}`, err)
      }
    }
    return null
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

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private isEnabled(): boolean {
    return this.config !== null && this.config.enabled === true
  }

  private backfillTabState(tabId: number, tab: chrome.tabs.Tab | undefined, now: number): TabState {
    const url = tab?.url ?? ''
    const state: TabState = {
      sessionId: makeSessionId(),
      windowId: tab?.windowId ?? -1,
      openedAtMs: now,
      lastFocusAtMs: tab?.active ? now : null,
      focusDurationMs: 0,
      currentUrl: url,
      currentUrlShownAtMs: now,
      currentUrlFocusMs: 0,
      lastTitle: tab?.title ?? '',
      priorUrl: null,
    }
    this.tabState.set(tabId, state)
    return state
  }
}

const plugin = new REXPageEventsServiceWorkerModule()

registerREXModule(plugin)

export default plugin
