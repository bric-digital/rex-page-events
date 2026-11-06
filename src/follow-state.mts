import { type NewTabDescription, type OpenMode, type PendingClick } from './link-follow.mjs'

export const FOLLOW_STATE_STORAGE_KEY = 'rexPageEventsFollowState'
export const DEFAULT_LINK_FOLLOW_MATCH_WINDOW_MS = 5000

export interface OpenFollow {
  clickId: string
  sourceTabId: number
  sourceUrl: string
  targetTabId: number
  claimed: boolean
  openMode: OpenMode
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
}

export function emptyFollowState(): FollowState {
  return { pending: [], open: new Map(), heldNewTabs: [] }
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

export function saveFollowState(state: FollowState): Promise<void> {
  return chrome.storage.session.set({
    [FOLLOW_STATE_STORAGE_KEY]: {
      pending: state.pending,
      open: Array.from(state.open.entries()),
      heldNewTabs: state.heldNewTabs,
    },
  })
}
