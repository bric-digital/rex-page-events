import { type HiddenLinkMode } from './types.mjs'

const NOT_ON_ALLOWLIST = 'NOT_ON_ALLOWLIST'

const HIDDEN_LINK_MODES: readonly HiddenLinkMode[] = ['show', 'text_only', 'hide']

export interface LinkRedaction {
  url: string
  filtered: boolean
  filtered_by_list?: string
}

export interface FilterListLookup {
  match: LinkRedaction | null
  failed: boolean
}

export interface ClickLinkFields {
  link_url: string
  link_text?: string
}

function defaultHiddenLinkMode(linkFollowOn: boolean): HiddenLinkMode {
  return linkFollowOn ? 'show' : 'text_only'
}

export function hiddenLinkModeOf(configured: unknown, linkFollowOn: boolean): HiddenLinkMode {
  return HIDDEN_LINK_MODES.find((mode) => mode === configured) ?? defaultHiddenLinkMode(linkFollowOn)
}

export function originOf(address: string): string | undefined {
  try {
    const origin = new URL(address).origin

    return origin === 'null' ? undefined : origin
  } catch {
    return undefined
  }
}

export function isOnSameSite(address: string, pageAddress: string): boolean {
  const origin = originOf(address)

  return origin !== undefined && origin === originOf(pageAddress)
}

export function claimsRevealingOrigin(claimed: boolean, address: string, pageAddress: string): boolean {
  return claimed && !isOnSameSite(address, pageAddress)
}

export function revealsOrigin(mode: HiddenLinkMode, claimed: boolean, redaction: LinkRedaction): boolean {
  return mode === 'show' && claimed && redaction.filtered_by_list === NOT_ON_ALLOWLIST
}

export function keptAddressOf(
  mode: HiddenLinkMode,
  claimed: boolean,
  redaction: LinkRedaction,
  address: string,
  filterLookup: FilterListLookup | null,
): string {
  if (!revealsOrigin(mode, claimed, redaction) || filterLookup === null || filterLookup.failed) {
    return redaction.url
  }

  return filterLookup.match?.url ?? originOf(address) ?? redaction.url
}

function keepsLinkText(mode: HiddenLinkMode, redaction: LinkRedaction): boolean {
  return !redaction.filtered || mode === 'show' || mode === 'text_only'
}

export function clickLinkFieldsFor(
  mode: HiddenLinkMode,
  claimed: boolean,
  redaction: LinkRedaction,
  address: string,
  text: string | undefined,
  filterLookup: FilterListLookup | null,
): ClickLinkFields {
  return {
    link_url: keptAddressOf(mode, claimed, redaction, address, filterLookup),
    link_text: keepsLinkText(mode, redaction) ? text : undefined,
  }
}
