import { type HiddenLinkMode } from './types.mjs'

export const DEFAULT_HIDDEN_LINK_MODE: HiddenLinkMode = 'text_only'

const NOT_ON_ALLOWLIST = 'NOT_ON_ALLOWLIST'

const HIDDEN_LINK_MODES: readonly HiddenLinkMode[] = ['show', 'text_only', 'hide']

export interface LinkRedaction {
  url: string
  filtered: boolean
  filtered_by_list?: string
}

export interface ClickLinkFields {
  link_url: string
  link_text?: string
}

export function hiddenLinkModeOf(configured: unknown): HiddenLinkMode {
  return HIDDEN_LINK_MODES.find((mode) => mode === configured) ?? DEFAULT_HIDDEN_LINK_MODE
}

function originOf(address: string): string | undefined {
  try {
    return new URL(address).origin
  } catch {
    return undefined
  }
}

export function revealsOrigin(mode: HiddenLinkMode, redaction: LinkRedaction): boolean {
  return mode === 'show' && redaction.filtered_by_list === NOT_ON_ALLOWLIST
}

function linkUrlFor(
  mode: HiddenLinkMode,
  redaction: LinkRedaction,
  address: string,
  filterRedaction: LinkRedaction | null,
): string {
  if (revealsOrigin(mode, redaction)) {
    return filterRedaction?.url ?? originOf(address) ?? redaction.url
  }

  return redaction.url
}

function keepsLinkText(mode: HiddenLinkMode, redaction: LinkRedaction): boolean {
  return !redaction.filtered || mode === 'show' || mode === 'text_only'
}

export function clickLinkFieldsFor(
  mode: HiddenLinkMode,
  redaction: LinkRedaction,
  address: string,
  text: string | undefined,
  filterRedaction: LinkRedaction | null,
): ClickLinkFields {
  return {
    link_url: linkUrlFor(mode, redaction, address, filterRedaction),
    link_text: keepsLinkText(mode, redaction) ? text : undefined,
  }
}
