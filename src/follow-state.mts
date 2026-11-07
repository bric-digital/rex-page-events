import { type HeldNavigation, type NewTabDescription, type OpenMode, type PendingClick } from './link-follow.mjs'

export const FOLLOW_STATE_STORAGE_KEY = 'rexPageEventsFollowState'
export const DEFAULT_LINK_FOLLOW_MATCH_WINDOW_MS = 5000

export interface OpenFollow {
  clickId: string
  sourceTabId: number
  sourceSessionId: string
  sourceWindowId: number
  sourceUrl: string
  sourceUrlShownAtMs: number
  targetTabId: number
  claimed: boolean
  claimDestinationUrl?: string
  redirectUrl?: string
  openMode: OpenMode
  shownAtMs?: number
  firstFocusedAtMs?: number
  focusAtShownMs?: number
  destinationUrl?: string
}

export interface HeldNewTab {
  tabId: number
  tab: NewTabDescription
  createdAtMs: number
}

export interface FollowState {
  pending: PendingClick[]
  open: Map<string, OpenFollow>
  heldNewTabs: HeldNewTab[]
  heldNavigations: HeldNavigation[]
  windowCreations: Map<number, number>
}

interface SavedFollowState {
  pending?: PendingClick[]
  open?: [string, OpenFollow][]
  heldNewTabs?: HeldNewTab[]
  heldNavigations?: HeldNavigation[]
  windowCreations?: [number, number][]
}

export function emptyFollowState(): FollowState {
  return { pending: [], open: new Map(), heldNewTabs: [], heldNavigations: [], windowCreations: new Map() }
}

export function followStateFrom(saved: SavedFollowState | undefined): FollowState {
  return {
    pending: saved?.pending ?? [],
    open: new Map(saved?.open ?? []),
    heldNewTabs: saved?.heldNewTabs ?? [],
    heldNavigations: saved?.heldNavigations ?? [],
    windowCreations: new Map(saved?.windowCreations ?? []),
  }
}

export function expiryStartsOf(state: FollowState): number[] {
  return [
    ...state.pending.map((click) => click.clickedAtMs),
    ...state.heldNewTabs.map((held) => held.createdAtMs),
    ...state.heldNavigations.map((held) => held.atMs),
    ...state.windowCreations.values(),
  ]
}

export function matchWindowMsOf(configured: unknown): number {
  return typeof configured === 'number' && Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_LINK_FOLLOW_MATCH_WINDOW_MS
}

export function addPendingClick(state: FollowState, click: PendingClick): void {
  state.pending.push(click)
}

function isExpired(click: PendingClick, nowMs: number, windowMs: number): boolean {
  return nowMs - click.clickedAtMs > windowMs
}

export function takeExpiredClicks(state: FollowState, nowMs: number, windowMs: number): PendingClick[] {
  const expired = state.pending.filter((click) => isExpired(click, nowMs, windowMs))

  state.pending = state.pending.filter((click) => !isExpired(click, nowMs, windowMs))

  return expired
}

export function holdNewTab(state: FollowState, held: HeldNewTab): void {
  state.heldNewTabs.push(held)
}

export function releaseHeldNewTab(state: FollowState, tabId: number): void {
  state.heldNewTabs = state.heldNewTabs.filter((held) => held.tabId !== tabId)
}

export function dropExpiredHeldNewTabs(state: FollowState, nowMs: number, windowMs: number): void {
  state.heldNewTabs = state.heldNewTabs.filter((held) => nowMs - held.createdAtMs <= windowMs)
}

export function holdNavigation(state: FollowState, held: HeldNavigation): void {
  state.heldNavigations.push(held)
}

export function releaseHeldNavigation(state: FollowState, released: HeldNavigation): void {
  state.heldNavigations = state.heldNavigations.filter((held) => held !== released)
}

export function unshownHeldNavigationsTo(state: FollowState, tabId: number, url: string | undefined): HeldNavigation[] {
  return state.heldNavigations.filter((held) => held.tabId === tabId && held.toUrl === url && held.shownAtMs === undefined)
}

export function sourceShownAtMsOf(state: FollowState, tabId: number, pageUrl: string, clickedAtMs: number): number | undefined {
  return state.heldNavigations
    .filter((held) => held.tabId === tabId && held.fromUrl === pageUrl && held.atMs >= clickedAtMs)
    .reduce<HeldNavigation | undefined>((earliest, held) => (earliest === undefined || held.atMs < earliest.atMs ? held : earliest), undefined)
    ?.fromShownAtMs
}

export function dropExpiredHeldNavigations(state: FollowState, nowMs: number, windowMs: number): void {
  state.heldNavigations = state.heldNavigations.filter((held) => nowMs - held.atMs <= windowMs)
}

export function noteWindowCreated(state: FollowState, windowId: number, createdAtMs: number): void {
  state.windowCreations.set(windowId, createdAtMs)
}

export function windowCreatedAtMsOf(state: FollowState, windowId: number): number | undefined {
  return state.windowCreations.get(windowId)
}

export function dropExpiredWindowCreations(state: FollowState, nowMs: number, windowMs: number): void {
  for (const [windowId, createdAtMs] of state.windowCreations) {
    if (nowMs - createdAtMs > windowMs) {
      state.windowCreations.delete(windowId)
    }
  }
}

function isSupersededBy(candidate: PendingClick, resolved: PendingClick): boolean {
  return candidate.tabId === resolved.tabId &&
    candidate.linkUrl === resolved.linkUrl &&
    candidate.clickedAtMs <= resolved.clickedAtMs
}

export function resolvePendingClick(state: FollowState, resolved: PendingClick): void {
  state.pending = state.pending.filter((click) => click !== resolved && !isSupersededBy(click, resolved))
}

export function openFollow(state: FollowState, follow: OpenFollow): void {
  state.open.set(follow.clickId, follow)
}

export function followsTargeting(state: FollowState, tabId: number): OpenFollow[] {
  return Array.from(state.open.values()).filter((follow) => follow.targetTabId === tabId)
}

export function closeFollow(state: FollowState, clickId: string): void {
  state.open.delete(clickId)
}

export function saveFollowState(state: FollowState): Promise<void> {
  return chrome.storage.session.set({
    [FOLLOW_STATE_STORAGE_KEY]: {
      pending: state.pending,
      open: Array.from(state.open.entries()),
      heldNewTabs: state.heldNewTabs,
      heldNavigations: state.heldNavigations,
      windowCreations: Array.from(state.windowCreations.entries()),
    },
  })
}

export function loadFollowState(): Promise<FollowState> {
  return chrome.storage.session.get(FOLLOW_STATE_STORAGE_KEY)
    .then((saved) => followStateFrom(saved[FOLLOW_STATE_STORAGE_KEY] as SavedFollowState | undefined))
}
