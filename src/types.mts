export type BrowserEventType = 'page_show' | 'page_hide' | 'load' | 'scroll'

export type PageEventType =
  | BrowserEventType
  | 'tab_open'
  | 'tab_url_change'
  | 'tab_focus'
  | 'tab_blur'
  | 'tab_close'
  | 'window_close'
  | 'click'
  | 'link_follow'
  | 'link_follow_end'

export type EventTypeSwitch = Exclude<PageEventType, 'link_follow_end'>

export type ClickType = 'primary' | 'middle' | 'right' | 'other'

export type HiddenLinkMode = 'show' | 'text_only' | 'hide'

export type ModifierKey = 'shift' | 'control' | 'alt' | 'meta'

export interface ScrollPosition {
  top: number
  left: number
  width: number
  height: number
  document_height: number
  document_width: number
}

export interface PageEventMessage {
  messageType: 'pageEvent'
  event_type: BrowserEventType
  url: string
  title: string
  timestamp: number
  persisted?: boolean
  scroll_position?: ScrollPosition
}

export interface ClickClaim {
  destination_url?: string
}

export interface ClickMessage {
  messageType: 'pageClick'
  click_id: string
  url: string
  title: string
  timestamp: number
  click_type: ClickType
  button: number
  modifier_keys: ModifierKey[]
  click_count: number
  on_link: boolean
  link_url?: string
  link_text?: string
  link_target?: string
  claim?: ClickClaim
}

export interface LinkFollowTotalsMessage {
  messageType: 'linkFollowTotals'
}

export interface LinkFollowTotal {
  click_id: string
  shown: boolean
  total_focus_duration_ms: number
}

export interface REXPageEventsConfiguration {
  enabled: boolean
  filter_lists?: string[]
  allow_lists?: string[]
  allow_all?: boolean
  domain_only_lists?: string[]
  event_types?: Partial<Record<EventTypeSwitch, boolean>>
  hidden_link_mode?: HiddenLinkMode
  scroll_pause_delay?: number
  link_follow_match_window?: number
}
