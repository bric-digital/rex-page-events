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
  dropExpiredHeldNavigations,
  dropExpiredHeldNewTabs,
  dropExpiredWindowCreations,
  emptyFollowState,
  expiryStartsOf,
  followsTargeting,
  holdNavigation,
  holdNewTab,
  loadFollowState,
  matchWindowMsOf,
  noteWindowCreated,
  openFollow,
  releaseHeldNavigation,
  releaseHeldNewTab,
  resolvePendingClick,
  saveFollowState,
  sourceShownAtMsOf,
  unshownHeldNavigationsTo,
  takeExpiredClicks,
  windowCreatedAtMsOf,
} from './follow-state.mjs'
import {
  type ClickLinkFields,
  type FilterListLookup,
  type LinkRedaction,
  claimsRevealingOrigin,
  clickLinkFieldsFor,
  hiddenLinkModeOf,
  keptAddressOf,
  revealsOrigin,
} from './hidden-link-mode.mjs'
import {
  type EndReason,
  type HeldNavigation,
  type MatchedBy,
  type OpenMode,
  type PendingClick,
  type ShownTimes,
  focusedMsAt,
  isFragmentOnlyChange,
  matchHeldNavigation,
  matchNewTab,
  matchSameTab,
  newTabAddressOf,
  redirectAddressOf,
} from './link-follow.mjs'
import { type TabState, loadTabState, newTabState, saveTabState } from './tab-state.mjs'
import {
  type ClickMessage,
  type LinkFollowTotal,
  type LinkFollowTotalsMessage,
  type EventTypeSwitch,
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

interface RedactionResult {
  url: string
  title?: string
  filtered: boolean
  filtered_by_list?: string
  allowed_by_list?: string
}

export type UrlActiveListener = (event: RexPageUrlActiveEvent) => void

const urlActiveListeners: Set<UrlActiveListener> = new Set()

export function subscribeUrlActive(listener: UrlActiveListener): () => void {
  urlActiveListeners.add(listener)
  return () => {
    urlActiveListeners.delete(listener)
  }
}

// @ts-expect-error: __rexPageEventsUrlActive is not defined on the service worker's global object
self.__rexPageEventsUrlActive = { subscribe: subscribeUrlActive }

function extractHostname(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

function isOnTheWayToDestination(follow: OpenFollow, url: string): boolean {
  return follow.shownAtMs === undefined && (url === follow.redirectUrl || url === follow.destinationUrl)
}

function tabStateWithoutTab(sessionId: string, windowId: number, shownAtMs: number): TabState {
  return newTabState({ sessionId, windowId, shownAtMs, focused: false, url: '', title: '' })
}

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

    this.handlerQueue = Promise.all([this.loadSavedTabState(), this.loadSavedFollowState(), this.loadStoredConfiguration()])
      .then(() => {
        this.rearmFollowExpiry()
      })
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
    message: PageEventMessage | ClickMessage | LinkFollowTotalsMessage,
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
    if (message.messageType === 'linkFollowTotals') {
      this.enqueue(async () => {
        sendResponse(this.linkFollowTotals(Date.now()))
      })
      return true
    }
    return false
  }

  private linkFollowTotals(nowMs: number): LinkFollowTotal[] {
    return [...this.followState.open.values()].map((follow) => ({
      click_id: follow.clickId,
      shown: follow.shownAtMs !== undefined,
      total_focus_duration_ms: this.timeInFrontOf(follow, nowMs),
    }))
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

    chrome.windows.onCreated.addListener((window) => {
      this.enqueue(() => this.onWindowCreated(window))
    })

    chrome.windows.onRemoved.addListener((windowId) => {
      this.enqueue(() => this.onWindowRemoved(windowId))
    })

    chrome.windows.onFocusChanged.addListener((windowId) => {
      this.enqueue(() => this.onWindowFocusChanged(windowId))
    })
  }

  private async onWindowCreated(window: chrome.windows.Window) {
    if (window.id === undefined || !this.isEventTypeOn('link_follow')) {
      return
    }

    const nowMs = Date.now()

    noteWindowCreated(this.followState, window.id, nowMs)
    this.scheduleExpiry(nowMs)
    await this.resolveHeldNewTabs(nowMs)
    await this.storeFollowState()
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

    await this.emit('tab_open', state, tab.id, url, title, nowMs, extras)
    this.deliverUrlActive(state, tab.id, url, nowMs)

    await this.resolveNewTabFollow(tab, tab.id, nowMs)

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

    await this.emit(
      'tab_url_change',
      state,
      tabId,
      outgoingUrl,
      outgoingTitle,
      nowMs,
      {
        url_focus_duration_ms: urlFocusDurationMs,
        url_dwell_ms: urlDwellMs,
        previous_url: previousUrlRedacted,
        previous_url_filtered: previousUrlFiltered,
      },
      state.currentUrlShownAtMs
    )

    if (!(await this.resolveSameTabFollow(tabId, outgoingUrl, newUrl, nowMs))) {
      await this.applyFollowEndRules(tabId, newUrl, nowMs)
      await this.holdNavigationForLateClick({
        tabId, fromUrl: outgoingUrl, fromShownAtMs: state.currentUrlShownAtMs, toUrl: newUrl, atMs: nowMs,
      })
    }

    state.previousUrl = outgoingUrl
    state.currentUrl = newUrl
    state.currentUrlShownAtMs = nowMs
    state.currentUrlFocusMs = 0
    state.lastTitle = tab.title || ''

    this.deliverUrlActive(state, tabId, newUrl, nowMs)

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
      await this.endFollowsTargeting(tabId, removeInfo.isWindowClosing ? 'window_closed' : 'tab_closed', nowMs)
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

    await this.emit(
      'tab_close',
      state,
      tabId,
      state.currentUrl,
      state.lastTitle,
      nowMs,
      {
        tab_lifetime_ms: tabLifetimeMs,
        focus_duration_ms: state.focusDurationMs,
        url_focus_duration_ms: state.currentUrlFocusMs,
        url_dwell_ms: urlDwellMs,
        is_window_closing: removeInfo.isWindowClosing,
      }
    )

    await this.endFollowsTargeting(tabId, removeInfo.isWindowClosing ? 'window_closed' : 'tab_closed', nowMs)

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
        await this.emit('tab_blur', otherState, otherTabId, otherState.currentUrl, otherState.lastTitle, nowMs)
      }
    }

    const state = this.tabState.get(tabId)
    if (state !== undefined && state.lastFocusAtMs === null) {
      state.lastFocusAtMs = nowMs
      await this.emit('tab_focus', state, tabId, state.currentUrl, state.lastTitle, nowMs)
      await this.noteFollowTargetFocused(tabId, nowMs)
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
        await this.emit('tab_blur', state, tabId, state.currentUrl, state.lastTitle, nowMs)
      }
    }

    if (windowLost === false) {
      const [activeTab] = await chrome.tabs.query({ active: true, windowId })
      const state = activeTab?.id === undefined ? undefined : this.tabState.get(activeTab.id)

      if (activeTab?.id !== undefined && state !== undefined && state.lastFocusAtMs === null) {
        state.lastFocusAtMs = nowMs
        await this.emit('tab_focus', state, activeTab.id, state.currentUrl, state.lastTitle, nowMs)
        await this.noteFollowTargetFocused(activeTab.id, nowMs)
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
    await this.emit('window_close', synthetic, undefined, '', '', nowMs, { window_id: windowId })
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

    await this.emit(message.event_type, state, tabId, url, title, nowMs, extras)

    if (message.event_type === 'page_show' && message.persisted === true) {
      await this.endFollowsReturningTo(tabId, url, nowMs)
    }

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
    const pageShownAtMs = sourceShownAtMsOf(this.followState, tabId, url, dateMs) ?? state.currentUrlShownAtMs

    state.lastTitle = title

    await this.emit('click', state, tabId, url, title, dateMs, await this.clickExtras(message, url), pageShownAtMs)
    await this.startPendingFollow(message, sender.tab, state, url, pageShownAtMs, dateMs)

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
    return hiddenLinkModeOf(this.config?.hidden_link_mode, this.isEventTypeOn('link_follow'))
  }

  private filterLookupFor(
    mode: HiddenLinkMode,
    claimed: boolean,
    redaction: LinkRedaction,
    address: string
  ): Promise<FilterListLookup | null> {
    return revealsOrigin(mode, claimed, redaction) ? this.lookUpFilterLists(address) : Promise.resolve(null)
  }

  private async startPendingFollow(
    message: ClickMessage,
    tab: chrome.tabs.Tab,
    sourceState: TabState,
    sourceUrl: string,
    sourceUrlShownAtMs: number,
    clickedAtMs: number
  ) {
    const opensPages = message.click_type === 'primary' || message.click_type === 'middle'
    const startsFollow = opensPages && (message.on_link || message.claim !== undefined)

    if (tab.id === undefined || !startsFollow || !this.isEventTypeOn('link_follow') || !(await this.isAllowedPage(sourceUrl))) {
      return
    }

    const click: PendingClick = {
      clickId: message.click_id,
      tabId: tab.id,
      windowId: tab.windowId,
      sessionId: sourceState.sessionId,
      sourceUrl,
      sourceUrlShownAtMs,
      clickedAtMs,
      linkUrl: message.link_url,
      claimed: message.claim !== undefined,
      claimDestinationUrl: message.claim?.destination_url,
      shiftHeld: message.modifier_keys.includes('shift'),
    }

    addPendingClick(this.followState, click)
    this.scheduleExpiry(clickedAtMs)

    await this.resolveHeldNavigation(click)
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

  private rearmFollowExpiry() {
    for (const startedAtMs of expiryStartsOf(this.followState)) {
      this.scheduleExpiry(startedAtMs)
    }
  }

  private async expirePendingClicks() {
    const nowMs = Date.now()
    const expired = takeExpiredClicks(this.followState, nowMs, this.matchWindowMs())

    dropExpiredHeldNewTabs(this.followState, nowMs, this.matchWindowMs())
    dropExpiredHeldNavigations(this.followState, nowMs, this.matchWindowMs())
    dropExpiredWindowCreations(this.followState, nowMs, this.matchWindowMs())

    for (const click of expired.filter((candidate) => candidate.claimed)) {
      await this.emitLinkFollow(click, 'none', undefined, undefined, nowMs)
    }

    await this.storeFollowState()
  }

  private async resolveSameTabFollow(tabId: number, fromUrl: string, toUrl: string, nowMs: number): Promise<boolean> {
    const click = matchSameTab(this.followState.pending, tabId, fromUrl, toUrl, nowMs, this.matchWindowMs())

    if (click === null) {
      return false
    }

    await this.resolveFollow(click, 'same_tab', undefined, tabId, toUrl, nowMs)

    return true
  }

  private async holdNavigationForLateClick(navigation: HeldNavigation) {
    if (!this.isEventTypeOn('link_follow') || isFragmentOnlyChange(navigation.fromUrl, navigation.toUrl)) {
      return
    }

    if (!(await this.isAllowedPage(navigation.fromUrl))) {
      return
    }

    holdNavigation(this.followState, navigation)
    this.scheduleExpiry(navigation.atMs)
    await this.storeFollowState()
  }

  private async resolveHeldNavigation(click: PendingClick) {
    const navigation = matchHeldNavigation(this.followState.heldNavigations, click, this.matchWindowMs())

    if (navigation === null) {
      return
    }

    const shown = navigation.toUrl === redirectAddressOf(click) ? {} : shownTimesOf(navigation)

    releaseHeldNavigation(this.followState, navigation)
    await this.resolveFollow(click, 'same_tab', undefined, navigation.tabId, navigation.toUrl, navigation.atMs, shown)
  }

  private async resolveNewTabFollow(tab: chrome.tabs.Tab, tabId: number, nowMs: number) {
    if (!this.isEventTypeOn('link_follow')) {
      return
    }

    const description = { openerTabId: tab.openerTabId, windowId: tab.windowId, pendingUrl: tab.pendingUrl, url: tab.url || undefined }
    const match = matchNewTab(
      this.followState.pending, description, nowMs, this.matchWindowMs(), windowCreatedAtMsOf(this.followState, tab.windowId)
    )

    if (match !== null) {
      await this.resolveFollow(match.click, match.openMode, match.matchedBy, tabId, newTabAddressOf(tab), nowMs)
      return
    }

    holdNewTab(this.followState, { tabId, tab: description, createdAtMs: nowMs })
    this.scheduleExpiry(nowMs)
    await this.storeFollowState()
  }

  private async resolveHeldNewTabs(nowMs: number) {
    for (const held of [...this.followState.heldNewTabs]) {
      const match = matchNewTab(
        this.followState.pending, held.tab, held.createdAtMs, this.matchWindowMs(), windowCreatedAtMsOf(this.followState, held.tab.windowId)
      )

      if (match !== null) {
        releaseHeldNewTab(this.followState, held.tabId)
        await this.resolveFollow(match.click, match.openMode, match.matchedBy, held.tabId, newTabAddressOf(held.tab), nowMs)
      }
    }
  }

  private async resolveFollow(
    click: PendingClick,
    openMode: OpenMode,
    matchedBy: MatchedBy | undefined,
    targetTabId: number,
    destinationUrl: string | undefined,
    nowMs: number,
    shown: ShownTimes = {}
  ) {
    await this.endFollowsTargeting(click.tabId, 'new_follow', nowMs)

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
      claimDestinationUrl: click.claimDestinationUrl,
      redirectUrl: redirectAddressOf(click),
      openMode,
      destinationUrl: knownDestinationUrl,
      ...shown,
    })

    await this.emitLinkFollow(click, openMode, matchedBy, targetTabId, nowMs)
    await this.storeFollowState()
  }

  private async emitLinkFollow(
    click: PendingClick,
    openMode: OpenMode,
    matchedBy: MatchedBy | undefined,
    targetTabId: number | undefined,
    nowMs: number
  ) {
    const sourceState = this.sourceTabStateOf(click.tabId, click.sessionId, click.windowId, click.clickedAtMs)

    await this.emit('link_follow', sourceState, click.tabId, click.sourceUrl, undefined, nowMs, {
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
      .then(newTabAddressOf)
      .catch(() => undefined)
  }

  private async onTabComplete(tabId: number, tab: chrome.tabs.Tab) {
    const state = this.tabState.get(tabId)
    const loadedUrl = tab.url ?? state?.currentUrl
    const unshown = followsTargeting(this.followState, tabId)
      .filter((follow) => follow.shownAtMs === undefined && follow.redirectUrl !== loadedUrl)
    const unshownHeld = unshownHeldNavigationsTo(this.followState, tabId, loadedUrl)

    if (!this.isEnabled() || unshown.length + unshownHeld.length === 0 || state === undefined) {
      return
    }

    const nowMs = Date.now()
    const shown: ShownTimes = {
      shownAtMs: nowMs,
      focusAtShownMs: focusedMsAt(state.focusDurationMs, state.lastFocusAtMs, nowMs),
      firstFocusedAtMs: state.lastFocusAtMs === null ? undefined : nowMs,
    }

    for (const follow of unshown) {
      Object.assign(follow, shown, { destinationUrl: loadedUrl })
    }

    for (const held of unshownHeld) {
      Object.assign(held, shown)
    }

    await this.storeFollowState()
  }

  private async noteFollowTargetFocused(tabId: number, nowMs: number) {
    const unfocused = followsTargeting(this.followState, tabId)
      .filter((follow) => follow.shownAtMs !== undefined && follow.firstFocusedAtMs === undefined)

    for (const follow of unfocused) {
      follow.firstFocusedAtMs = nowMs
    }

    if (unfocused.length > 0) {
      await this.storeFollowState()
    }
  }

  private async applyFollowEndRules(tabId: number, newUrl: string, nowMs: number) {
    await this.endFollowsReturningTo(tabId, newUrl, nowMs)

    const follows = followsTargeting(this.followState, tabId)

    if (follows.length === 0) {
      return
    }

    const allowedPage = await this.isAllowedPage(newUrl)

    for (const follow of follows) {
      if (allowedPage && !isOnTheWayToDestination(follow, newUrl)) {
        await this.endFollow(follow, 'allow_listed_page', nowMs)
      } else if (follow.shownAtMs === undefined) {
        follow.destinationUrl = newUrl
      }
    }

    await this.storeFollowState()
  }

  private async endFollowsReturningTo(tabId: number, url: string, nowMs: number) {
    for (const follow of followsTargeting(this.followState, tabId).filter((open) => open.sourceUrl === url)) {
      await this.endFollow(follow, 'back', nowMs)
    }
  }

  private async endFollowsTargeting(tabId: number, reason: EndReason, nowMs: number) {
    for (const follow of followsTargeting(this.followState, tabId)) {
      await this.endFollow(follow, reason, nowMs)
    }
  }

  private async endFollow(follow: OpenFollow, reason: EndReason, nowMs: number) {
    closeFollow(this.followState, follow.clickId)

    const sourceState = this.sourceTabStateOf(follow.sourceTabId, follow.sourceSessionId, follow.sourceWindowId, nowMs)
    await this.emit('link_follow_end', sourceState, follow.sourceTabId, follow.sourceUrl, undefined, nowMs, {
      click_id: follow.clickId,
      destination_url: await this.redactDestination(this.destinationAddressOf(follow), follow.claimed),
      shown_at: follow.shownAtMs,
      first_focused_at: follow.firstFocusedAtMs,
      total_focus_duration_ms: this.timeInFrontOf(follow, nowMs),
      before_load: follow.shownAtMs === undefined,
      end_reason: reason,
    }, follow.sourceUrlShownAtMs)
    await this.storeFollowState()
  }

  private timeInFrontOf(follow: OpenFollow, nowMs: number): number {
    const state = this.tabState.get(follow.targetTabId)

    if (follow.focusAtShownMs === undefined || state === undefined) {
      return 0
    }

    return Math.max(0, focusedMsAt(state.focusDurationMs, state.lastFocusAtMs, nowMs) - follow.focusAtShownMs)
  }

  private destinationAddressOf(follow: OpenFollow): string {
    if (follow.shownAtMs === undefined && follow.claimDestinationUrl !== undefined) {
      return follow.claimDestinationUrl
    }

    return follow.destinationUrl ?? this.tabState.get(follow.targetTabId)?.currentUrl ?? ''
  }

  private async redactDestination(url: string, claimed: boolean): Promise<string> {
    const redaction = await this.redact(url, '')
    const mode = this.hiddenLinkMode()
    const filterLookup = await this.filterLookupFor(mode, claimed, redaction, url)

    return keptAddressOf(mode, claimed, redaction, url, filterLookup)
  }

  private storeFollowState(): Promise<void> {
    return saveFollowState(this.followState)
      .catch((error: unknown) => {
        console.debug(`${LOG_PREFIX} could not save follow state`, error)
      })
  }

  private async emit(
    eventType: PageEventType,
    state: TabState,
    tabId: number | undefined,
    url: string,
    title: string | undefined,
    dateMs: number,
    extras: Record<string, unknown> = {},
    urlShownAtOverrideMs?: number
  ) {
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
      url_shown_at: urlShownAtOverrideMs ?? state.currentUrlShownAtMs,
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

    for (const listener of urlActiveListeners) {
      try {
        listener(record)
      } catch (err) {
        console.warn(`${LOG_PREFIX} url-active listener threw`, err)
      }
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
    const switchName: EventTypeSwitch = eventType === 'link_follow_end' ? 'link_follow' : eventType
    const configured = this.config?.event_types?.[switchName]
    return typeof configured === 'boolean' ? configured : DEFAULT_EVENT_TYPES[switchName]
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

  private loadSavedFollowState(): Promise<void> {
    return loadFollowState()
      .then((state) => {
        this.followState = state
      })
      .catch((error: unknown) => {
        console.debug(`${LOG_PREFIX} could not load saved follow state`, error)
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

function shownTimesOf(navigation: HeldNavigation): ShownTimes {
  return {
    shownAtMs: navigation.shownAtMs,
    focusAtShownMs: navigation.focusAtShownMs,
    firstFocusedAtMs: navigation.firstFocusedAtMs,
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
