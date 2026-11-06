import { originOf } from './hidden-link-mode.mjs'

export { originOf }

export interface PendingClick {
  clickId: string
  tabId: number
  windowId: number
  sessionId: string
  sourceUrl: string
  clickedAtMs: number
  linkUrl?: string
  claimed: boolean
  claimDestinationUrl?: string
  shiftHeld: boolean
}

export type OpenMode = 'same_tab' | 'new_tab' | 'new_window' | 'none'

export type MatchedBy = 'opener' | 'address_and_time'

export type EndReason = 'back' | 'allow_listed_page' | 'new_follow' | 'tab_closed' | 'window_closed'

export interface NewTabDescription {
  openerTabId?: number
  windowId: number
  pendingUrl?: string
  url?: string
}

export interface NewTabMatch {
  click: PendingClick
  openMode: OpenMode
  matchedBy: MatchedBy
}

function withoutFragment(address: string): string {
  const fragmentStart = address.indexOf('#')

  return fragmentStart === -1 ? address : address.slice(0, fragmentStart)
}

function fragmentOf(address: string): string {
  const fragmentStart = address.indexOf('#')

  return fragmentStart === -1 ? '' : address.slice(fragmentStart)
}

export function isFragmentOnlyChange(fromUrl: string, toUrl: string): boolean {
  return withoutFragment(fromUrl) === withoutFragment(toUrl) && fragmentOf(fromUrl) !== fragmentOf(toUrl)
}

function isWithinWindow(clickedAtMs: number, atMs: number, windowMs: number): boolean {
  const elapsedMs = atMs - clickedAtMs

  return elapsedMs >= 0 && elapsedMs <= windowMs
}

function latestOf(clicks: PendingClick[]): PendingClick | null {
  return clicks.reduce<PendingClick | null>(
    (latest, candidate) => (latest === null || candidate.clickedAtMs > latest.clickedAtMs ? candidate : latest),
    null,
  )
}

function candidateAddressesOf(click: PendingClick): string[] {
  return [click.linkUrl, click.claimDestinationUrl].filter((address): address is string => address !== undefined)
}

function hasAddress(click: PendingClick, address: string | undefined): boolean {
  return address !== undefined && candidateAddressesOf(click).includes(address)
}

function preferredByAddress(clicks: PendingClick[], address: string | undefined): PendingClick | null {
  const byLinkUrl = clicks.filter((click) => address !== undefined && click.linkUrl === address)
  const byAnyAddress = clicks.filter((click) => hasAddress(click, address))

  return latestOf(byLinkUrl.length > 0 ? byLinkUrl : byAnyAddress)
}

function newTabAddress(tab: NewTabDescription): string | undefined {
  return tab.pendingUrl ?? tab.url
}

export function matchSameTab(
  pending: PendingClick[],
  tabId: number,
  fromUrl: string,
  toUrl: string,
  atMs: number,
  windowMs: number,
): PendingClick | null {
  if (isFragmentOnlyChange(fromUrl, toUrl)) {
    return null
  }

  return latestOf(pending.filter((click) => click.tabId === tabId && isWithinWindow(click.clickedAtMs, atMs, windowMs)))
}

function matchByOpener(
  pending: PendingClick[],
  tab: NewTabDescription,
  atMs: number,
  windowMs: number,
): NewTabMatch | null {
  const fromOpener = pending.filter(
    (click) => click.tabId === tab.openerTabId && isWithinWindow(click.clickedAtMs, atMs, windowMs),
  )
  const click = preferredByAddress(fromOpener, newTabAddress(tab)) ?? latestOf(fromOpener)

  if (click === null) {
    return null
  }

  return { click, openMode: click.windowId === tab.windowId ? 'new_tab' : 'new_window', matchedBy: 'opener' }
}

function matchByAddressAndTime(
  pending: PendingClick[],
  tab: NewTabDescription,
  atMs: number,
  windowMs: number,
  windowCreatedAtMs: number | undefined,
): NewTabMatch | null {
  const address = newTabAddress(tab)

  if (windowCreatedAtMs === undefined || address === undefined) {
    return null
  }

  const click = preferredByAddress(
    pending.filter(
      (candidate) =>
        candidate.shiftHeld &&
        candidate.windowId !== tab.windowId &&
        isWithinWindow(candidate.clickedAtMs, atMs, windowMs) &&
        isWithinWindow(candidate.clickedAtMs, windowCreatedAtMs, windowMs),
    ),
    address,
  )

  return click === null ? null : { click, openMode: 'new_window', matchedBy: 'address_and_time' }
}

export function matchNewTab(
  pending: PendingClick[],
  tab: NewTabDescription,
  atMs: number,
  windowMs: number,
  windowCreatedAtMs?: number,
): NewTabMatch | null {
  if (tab.openerTabId !== undefined) {
    return matchByOpener(pending, tab, atMs, windowMs)
  }

  return matchByAddressAndTime(pending, tab, atMs, windowMs, windowCreatedAtMs)
}

export function focusedMsAt(focusDurationMs: number, lastFocusAtMs: number | null, nowMs: number): number {
  return lastFocusAtMs === null ? focusDurationMs : focusDurationMs + Math.max(0, nowMs - lastFocusAtMs)
}
