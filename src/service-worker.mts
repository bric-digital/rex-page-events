import { type REXConfiguration } from '@bric/rex-core/common'
import rexCorePlugin, {
  REXServiceWorkerModule,
  registerREXModule,
  dispatchEvent,
} from '@bric/rex-core/service-worker'
import { matchDomainAgainstList } from '@bric/rex-lists'
import { type RexPageUrlActiveEvent } from '@bric/rex-types/types'

import {
  type FollowState,
  type OpenFollow,
  addPendingClick,
  closeFollow,
  dropExpiredHeldNewTabs,
  emptyFollowState,
  followsTargeting,
  holdNewTab,
  matchWindowMsOf,
  openFollow,
  releaseHeldNewTab,
  resolvePendingClick,
  saveFollowState,
  takeExpiredClicks,
} from './follow-state.mjs'
import { type ClickLinkFields, clickLinkFieldsFor, hiddenLinkModeOf, revealsOrigin } from './hidden-link-mode.mjs'
import {
  type EndReason,
  type MatchedBy,
  type OpenMode,
  type PendingClick,
  focusedMsAt,
  matchNewTab,
  matchSameTab,
} from './link-follow.mjs'
import { type ClickMessage, type EventTypeSwitch, type PageEventMessage, type PageEventType, type REXPageEventsConfiguration } from './types.mjs'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EVENT_NAME = 'rex-page-event'
const URL_ACTIVE_EVENT_NAME = 'rex-page-url-active' as const
const LOG_PREFIX = '[rex-page-events]'
const CONFIGURATION_TIMEOUT_MS = 10000
const SLOW_HANDLER_WARNING_MS = 10000
const TAB_STATE_STORAGE_KEY = 'rexPageEventsTabState'

const DEFAULT_EVENT_TYPES: Record<EventTypeSwitch, boolean> = {
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
  link_follow: false,
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
// URL-active subscriptions for other service-worker modules: rex-history finds
// `subscribeUrlActive` on the global object instead of importing this module.
// `subscribeUrlActive` returns a function that ends the subscription.
// ---------------------------------------------------------------------------

const urlActiveListeners: Set<UrlActiveListener> = new Set()

export function subscribeUrlActive(listener: UrlActiveListener): () => void {
  urlActiveListeners.add(listener)
  return () => {
    urlActiveListeners.delete(listener)
  }
}

// @ts-expect-error: __rexPageEventsUrlActive is not defined on the service worker's global object
self.__rexPageEventsUrlActive = { subscribe: subscribeUrlActive }

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

// TODO: generate session IDs one standard way (rex-page-events #28)
function makeSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function newTabAddressOf(tab: chrome.tabs.Tab): string | undefined {
  return tab.pendingUrl ?? (tab.url || undefined)
}

function tabStateWithoutTab(sessionId: string, windowId: number, shownAtMs: number): TabState {
  return {
    sessionId,
    windowId,
    openedAtMs: shownAtMs,
    lastFocusAtMs: null,
    focusDurationMs: 0,
    currentUrl: '',
    currentUrlShownAtMs: shownAtMs,
    currentUrlFocusMs: 0,
    lastTitle: '',
    priorUrl: null,
  }
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

class REXPageEventsServiceWorkerModule extends REXServiceWorkerModule {
  config: REXPageEventsConfiguration | null = null
  tabState: Map<number, TabState> = new Map()
  followState: FollowState = emptyFollowState()
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
      console.log(`${LOG_PREFIX} config loaded`, pageEventsConfig)
    }
  }

  handleMessage(
    message: PageEventMessage | ClickMessage,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void
  ): boolean {
    if (message && message.messageType === 'pageClick') {
      this.enqueue(() => this.recordClick(message, sender))
      sendResponse({ success: true })
      return true
    }
    if (message && message.messageType === 'pageEvent') {
      this.enqueue(() => this.recordPageEvent(message, sender))
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
      this.enqueue(() => this.onTabCreated(tab))
    })

    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (changeInfo.url !== undefined) {
        const url = changeInfo.url

        this.enqueue(() => this.onTabUrlChanged(tabId, url, tab))
      }
      if (changeInfo.status === 'complete') {
        this.enqueue(() => this.onTabComplete(tabId, tab))
      }
    })

    chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
      this.enqueue(() => this.onTabRemoved(tabId, removeInfo))
    })

    chrome.tabs.onActivated.addListener((activeInfo) => {
      this.enqueue(() => this.onTabActivated(activeInfo.tabId, activeInfo.windowId))
    })

    if (chrome.windows !== undefined) {
      if (chrome.windows.onRemoved !== undefined) {
        chrome.windows.onRemoved.addListener((windowId) => {
          this.enqueue(() => this.onWindowRemoved(windowId))
        })
      }
      if (chrome.windows.onFocusChanged !== undefined) {
        chrome.windows.onFocusChanged.addListener((windowId) => {
          this.enqueue(() => this.onWindowFocusChanged(windowId))
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

    await this.resolveNewTabFollow(tab, tab.id, now)

    await this.saveTabState()
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

    if (!(await this.resolveSameTabFollow(tabId, outgoingUrl, newUrl, now))) {
      await this.applyFollowEndRules(tabId, newUrl, now)
    }

    // Reset segment state for the new URL.
    state.priorUrl = outgoingUrl
    state.currentUrl = newUrl
    state.currentUrlShownAtMs = now
    state.currentUrlFocusMs = 0
    state.lastTitle = tab.title || ''

    // Announce the new URL so sibling modules can link.
    this.deliverUrlActive(state, tabId, newUrl, now)

    await this.saveTabState()
  }

  private async onTabRemoved(tabId: number, removeInfo: { windowId: number; isWindowClosing: boolean }) {
    if (!this.isEnabled()) {
      this.tabState.delete(tabId)
      await this.saveTabState()
      return
    }
    const now = Date.now()
    const state = this.tabState.get(tabId)
    if (state === undefined) {
      await this.endFollowsTargeting(tabId, removeInfo.isWindowClosing ? 'window_closed' : 'tab_closed', now)
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

    await this.endFollowsTargeting(tabId, removeInfo.isWindowClosing ? 'window_closed' : 'tab_closed', now)

    this.tabState.delete(tabId)
    await this.saveTabState()
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
    if (state !== undefined && state.lastFocusAtMs === null) {
      state.lastFocusAtMs = now
      await this.emit('tab_focus', state, tabId, state.currentUrl, state.lastTitle, now)
      await this.noteFollowTargetFocused(tabId, now)
    }

    await this.saveTabState()
  }

  private async onWindowFocusChanged(windowId: number) {
    if (!this.isEnabled()) {
      return
    }
    const now = Date.now()
    const windowLost = windowId === chrome.windows.WINDOW_ID_NONE

    // Blur every focused tab outside the window that now has focus; when no window has focus, every focused tab.
    for (const [tabId, state] of this.tabState.entries()) {
      if (state.lastFocusAtMs !== null && (windowLost || state.windowId !== windowId)) {
        const fragment = now - state.lastFocusAtMs
        state.focusDurationMs += fragment
        state.currentUrlFocusMs += fragment
        state.lastFocusAtMs = null
        await this.emit('tab_blur', state, tabId, state.currentUrl, state.lastTitle, now)
      }
    }

    if (windowLost === false) {
      const [activeTab] = await chrome.tabs.query({ active: true, windowId })
      const state = activeTab?.id === undefined ? undefined : this.tabState.get(activeTab.id)

      if (activeTab?.id !== undefined && state !== undefined && state.lastFocusAtMs === null) {
        state.lastFocusAtMs = now
        await this.emit('tab_focus', state, activeTab.id, state.currentUrl, state.lastTitle, now)
        await this.noteFollowTargetFocused(activeTab.id, now)
      }
    }

    await this.saveTabState()
  }

  private async onWindowRemoved(windowId: number) {
    if (!this.isEnabled()) {
      return
    }
    const now = Date.now()
    // window_close is window-level; no tab context.
    const synthetic = tabStateWithoutTab(makeSessionId(), windowId, now)
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

    if (message.event_type === 'page_show' && message.persisted === true) {
      await this.endFollowsReturningTo(tabId, url, now)
    }

    await this.saveTabState()
  }

  private async recordClick(message: ClickMessage, sender: chrome.runtime.MessageSender) {
    if (!this.isEnabled() || sender.tab?.id === undefined) {
      return
    }
    const tabId = sender.tab.id
    const timestamp = typeof message.timestamp === 'number' ? message.timestamp : Date.now()
    const url = message.url ?? sender.tab.url ?? ''
    const title = message.title ?? sender.tab.title ?? ''
    const state = this.tabState.get(tabId) ?? this.backfillTabState(tabId, sender.tab, timestamp)

    state.lastTitle = title

    await this.emit('click', state, tabId, url, title, timestamp, await this.clickExtras(message, url))
    await this.startPendingFollow(message, sender.tab, state, url, timestamp)

    await this.saveTabState()
  }

  private async clickExtras(message: ClickMessage, pageUrl: string): Promise<Record<string, unknown>> {
    const pageHidden = (await this.redact(pageUrl, message.title)).filtered
    const linkFields = pageHidden ? await this.hiddenPageLinkFields(message) : await this.allowedPageLinkFields(message)

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
    if (message.link_url === undefined) {
      return {}
    }

    return { link_url: (await this.redact(message.link_url, '')).url }
  }

  private async allowedPageLinkFields(message: ClickMessage): Promise<Partial<ClickLinkFields>> {
    if (message.link_url === undefined) {
      return { link_text: message.link_text }
    }

    const redaction = await this.redact(message.link_url, '')

    const mode = hiddenLinkModeOf(this.config?.hidden_link_mode)
    const filterRedaction = revealsOrigin(mode, redaction) ? await this.applyFilterLists(message.link_url) : null

    return clickLinkFieldsFor(mode, redaction, message.link_url, message.link_text, filterRedaction)
  }

  // -------------------------------------------------------------------------
  // Link following
  // -------------------------------------------------------------------------

  private async startPendingFollow(
    message: ClickMessage,
    tab: chrome.tabs.Tab,
    sourceState: TabState,
    sourceUrl: string,
    clickedAtMs: number
  ) {
    const opensPages = message.click_type === 'primary' || message.click_type === 'middle'
    const startsFollow = opensPages && (message.on_link || message.claim !== undefined)

    if (tab.id === undefined || !startsFollow || !this.isEventTypeOn('link_follow') || !(await this.isAllowedPage(sourceUrl))) {
      return
    }

    addPendingClick(this.followState, {
      clickId: message.click_id,
      tabId: tab.id,
      windowId: tab.windowId,
      sessionId: sourceState.sessionId,
      sourceUrl,
      sourceUrlShownAtMs: sourceState.currentUrlShownAtMs,
      clickedAtMs,
      linkUrl: message.link_url,
      claimed: message.claim !== undefined,
      claimDestinationUrl: message.claim?.destination_url,
      shiftHeld: message.modifier_keys.includes('shift'),
    })
    this.scheduleExpiry(clickedAtMs)

    await this.resolveHeldNewTabs(Date.now())
    await this.storeFollowState()
  }

  private matchWindowMs(): number {
    return matchWindowMsOf(this.config?.link_follow_match_window)
  }

  private scheduleExpiry(clickedAtMs: number) {
    const delayMs = Math.max(0, clickedAtMs + this.matchWindowMs() + 1 - Date.now())

    self.setTimeout(() => {
      this.enqueue(() => this.expirePendingClicks())
    }, delayMs)
  }

  private async expirePendingClicks() {
    const now = Date.now()
    const expired = takeExpiredClicks(this.followState, now, this.matchWindowMs())

    dropExpiredHeldNewTabs(this.followState, now, this.matchWindowMs())

    for (const click of expired.filter((candidate) => candidate.claimed)) {
      await this.emitLinkFollow(click, 'none', undefined, undefined, now)
    }

    await this.storeFollowState()
  }

  private async resolveSameTabFollow(tabId: number, fromUrl: string, toUrl: string, now: number): Promise<boolean> {
    const click = matchSameTab(this.followState.pending, tabId, fromUrl, toUrl, now, this.matchWindowMs())

    if (click === null) {
      return false
    }

    await this.resolveFollow(click, 'same_tab', undefined, tabId, toUrl, now)

    return true
  }

  private async resolveNewTabFollow(tab: chrome.tabs.Tab, tabId: number, now: number) {
    if (!this.isEventTypeOn('link_follow')) {
      return
    }

    const description = { openerTabId: tab.openerTabId, windowId: tab.windowId, pendingUrl: tab.pendingUrl, url: tab.url || undefined }
    const match = matchNewTab(this.followState.pending, description, now, this.matchWindowMs())

    if (match !== null) {
      await this.resolveFollow(match.click, match.openMode, match.matchedBy, tabId, newTabAddressOf(tab), now)
      return
    }

    holdNewTab(this.followState, { tabId, tab: description, createdAtMs: now })
    this.scheduleExpiry(now)
    await this.storeFollowState()
  }

  private async resolveHeldNewTabs(now: number) {
    for (const held of [...this.followState.heldNewTabs]) {
      const match = matchNewTab(this.followState.pending, held.tab, held.createdAtMs, this.matchWindowMs())

      if (match !== null) {
        releaseHeldNewTab(this.followState, held.tabId)
        await this.resolveFollow(match.click, match.openMode, match.matchedBy, held.tabId, held.tab.pendingUrl ?? held.tab.url, now)
      }
    }
  }

  private async resolveFollow(
    click: PendingClick,
    openMode: OpenMode,
    matchedBy: MatchedBy | undefined,
    targetTabId: number,
    destinationUrl: string | undefined,
    now: number
  ) {
    await this.endFollowsTargeting(click.tabId, 'new_follow', now)

    const knownDestinationUrl = destinationUrl ?? await this.pendingAddressOf(targetTabId)

    resolvePendingClick(this.followState, click)
    openFollow(this.followState, {
      clickId: click.clickId,
      sourceTabId: click.tabId,
      sourceSessionId: click.sessionId,
      sourceWindowId: click.windowId,
      sourceUrl: click.sourceUrl,
      sourceUrlShownAtMs: click.sourceUrlShownAtMs,
      targetTabId,
      claimed: click.claimed,
      openMode,
      destinationUrl: knownDestinationUrl,
    })

    await this.emitLinkFollow(click, openMode, matchedBy, targetTabId, now)
    await this.storeFollowState()
  }

  private async emitLinkFollow(
    click: PendingClick,
    openMode: OpenMode,
    matchedBy: MatchedBy | undefined,
    targetTabId: number | undefined,
    now: number
  ) {
    const sourceState = this.sourceTabStateOf(click.tabId, click.sessionId, click.windowId, click.clickedAtMs)

    await this.emit('link_follow', sourceState, click.tabId, click.sourceUrl, '', now, {
      click_id: click.clickId,
      open_mode: openMode,
      matched_by: matchedBy,
      target_tab_id: targetTabId,
      is_result: click.claimed,
    }, click.sourceUrlShownAtMs)
  }

  private sourceTabStateOf(tabId: number, sessionId: string, windowId: number, atMs: number): TabState {
    const state = this.tabState.get(tabId)

    return state !== undefined && state.sessionId === sessionId
      ? state
      : tabStateWithoutTab(sessionId, windowId, atMs)
  }

  private pendingAddressOf(tabId: number): Promise<string | undefined> {
    return chrome.tabs.get(tabId)
      .then((tab) => tab.pendingUrl ?? (tab.url || undefined))
      .catch(() => undefined)
  }

  private async onTabComplete(tabId: number, tab: chrome.tabs.Tab) {
    const unshown = followsTargeting(this.followState, tabId).filter((follow) => follow.shownAtMs === undefined)
    const state = this.tabState.get(tabId)

    if (!this.isEnabled() || unshown.length === 0 || state === undefined) {
      return
    }

    const now = Date.now()

    for (const follow of unshown) {
      follow.shownAtMs = now
      follow.focusAtShownMs = focusedMsAt(state.focusDurationMs, state.lastFocusAtMs, now)
      follow.firstFocusedAtMs = state.lastFocusAtMs === null ? undefined : now
      follow.destinationUrl = tab.url ?? state.currentUrl
    }

    await this.storeFollowState()
  }

  private async noteFollowTargetFocused(tabId: number, now: number) {
    const unfocused = followsTargeting(this.followState, tabId)
      .filter((follow) => follow.shownAtMs !== undefined && follow.firstFocusedAtMs === undefined)

    for (const follow of unfocused) {
      follow.firstFocusedAtMs = now
    }

    if (unfocused.length > 0) {
      await this.storeFollowState()
    }
  }

  private async applyFollowEndRules(tabId: number, newUrl: string, now: number) {
    await this.endFollowsReturningTo(tabId, newUrl, now)

    const follows = followsTargeting(this.followState, tabId)

    if (follows.length === 0) {
      return
    }

    for (const follow of follows.filter((open) => open.shownAtMs === undefined)) {
      follow.destinationUrl = newUrl
    }

    if (await this.isAllowedPage(newUrl)) {
      for (const follow of follows.filter((open) => open.shownAtMs !== undefined)) {
        await this.endFollow(follow, 'allow_listed_page', now)
      }
    }

    await this.storeFollowState()
  }

  private async endFollowsReturningTo(tabId: number, url: string, now: number) {
    for (const follow of followsTargeting(this.followState, tabId).filter((open) => open.sourceUrl === url)) {
      await this.endFollow(follow, 'back', now)
    }
  }

  private async endFollowsTargeting(tabId: number, reason: EndReason, now: number) {
    for (const follow of followsTargeting(this.followState, tabId)) {
      await this.endFollow(follow, reason, now)
    }
  }

  private async endFollow(follow: OpenFollow, reason: EndReason, now: number) {
    closeFollow(this.followState, follow.clickId)

    const sourceState = this.sourceTabStateOf(follow.sourceTabId, follow.sourceSessionId, follow.sourceWindowId, now)
    const destinationUrl = follow.destinationUrl ?? this.tabState.get(follow.targetTabId)?.currentUrl ?? ''

    await this.emit('link_follow_end', sourceState, follow.sourceTabId, follow.sourceUrl, '', now, {
      click_id: follow.clickId,
      destination_url: await this.redactDestination(destinationUrl),
      shown_at: follow.shownAtMs,
      first_focused_at: follow.firstFocusedAtMs,
      total_focus_duration_ms: this.timeInFrontOf(follow, now),
      before_load: follow.shownAtMs === undefined,
      end_reason: reason,
    }, follow.sourceUrlShownAtMs)
    await this.storeFollowState()
  }

  private timeInFrontOf(follow: OpenFollow, now: number): number {
    const state = this.tabState.get(follow.targetTabId)

    if (follow.focusAtShownMs === undefined || state === undefined) {
      return 0
    }

    return focusedMsAt(state.focusDurationMs, state.lastFocusAtMs, now) - follow.focusAtShownMs
  }

  private async redactDestination(url: string): Promise<string> {
    return (await this.redact(url, '')).url
  }

  private storeFollowState(): Promise<void> {
    return saveFollowState(this.followState)
      .catch((error: unknown) => {
        console.debug(`${LOG_PREFIX} could not save follow state`, error)
      })
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
    if (!this.isEventTypeOn(eventType)) {
      return
    }

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

  private isEventTypeOn(eventType: PageEventType): boolean {
    const switchName: EventTypeSwitch = eventType === 'link_follow_end' ? 'link_follow' : eventType
    const configured = this.config?.event_types?.[switchName]
    return typeof configured === 'boolean' ? configured : DEFAULT_EVENT_TYPES[switchName]
  }

  private saveTabState(): Promise<void> {
    return chrome.storage.session.set({ [TAB_STATE_STORAGE_KEY]: Array.from(this.tabState.entries()) })
      .catch((error: unknown) => {
        console.debug(`${LOG_PREFIX} could not save tab state`, error)
      })
  }

  private loadSavedTabState(): Promise<void> {
    return chrome.storage.session.get(TAB_STATE_STORAGE_KEY)
      .then((saved) => {
        const entries = saved[TAB_STATE_STORAGE_KEY] as [number, TabState][] | undefined

        if (entries !== undefined) {
          this.tabState = new Map(entries)
        }
      })
      .catch((error: unknown) => {
        console.debug(`${LOG_PREFIX} could not load saved tab state`, error)
      })
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
