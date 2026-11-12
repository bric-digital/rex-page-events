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

export type ClickType = 'primary' | 'middle' | 'right' | 'other'

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

export interface REXPageEventsConfiguration {
  enabled: boolean
  event_types?: Partial<Record<PageEventType, boolean>>
  scroll_pause_delay?: number
}
