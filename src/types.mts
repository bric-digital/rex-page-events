export type BrowserEventType = 'page_show' | 'page_hide' | 'tab_focus' | 'tab_blur' | 'load' | 'scroll'

export type PageEventType = BrowserEventType | 'tab_open' | 'tab_url_change' | 'tab_close' | 'window_close'

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
