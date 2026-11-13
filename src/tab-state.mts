const TAB_STATE_STORAGE_KEY = 'rexPageEventsTabState'

export interface TabState {
  sessionId: string
  windowId: number
  openedAtMs: number
  lastFocusAtMs: number | null
  focusDurationMs: number
  currentUrl: string
  currentUrlShownAtMs: number
  currentUrlFocusMs: number
  lastTitle: string
  previousUrl: string | null
  previousUrlShownAtMs: number | null
}

export interface NewTabStateFields {
  sessionId: string
  windowId: number
  shownAtMs: number
  focused: boolean
  url: string
  title: string
}

export function newTabState({ sessionId, windowId, shownAtMs, focused, url, title }: NewTabStateFields): TabState {
  return {
    sessionId,
    windowId,
    openedAtMs: shownAtMs,
    lastFocusAtMs: focused ? shownAtMs : null,
    focusDurationMs: 0,
    currentUrl: url,
    currentUrlShownAtMs: shownAtMs,
    currentUrlFocusMs: 0,
    lastTitle: title,
    previousUrl: null,
    previousUrlShownAtMs: null,
  }
}

export function saveTabState(tabState: Map<number, TabState>): Promise<void> {
  return chrome.storage.session.set({ [TAB_STATE_STORAGE_KEY]: Array.from(tabState.entries()) })
}

export function loadTabState(): Promise<Map<number, TabState> | null> {
  return chrome.storage.session.get(TAB_STATE_STORAGE_KEY)
    .then((saved) => {
      const entries = saved[TAB_STATE_STORAGE_KEY] as [number, TabState][] | undefined

      if (entries === undefined) {
        return null
      }

      return new Map(entries)
    })
}
