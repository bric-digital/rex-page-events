import { type ClickClaim, type ClickMessage, type ClickType, type ModifierKey } from './types.mjs'

const LINK_TEXT_LIMIT = 200
const PRIMARY_BUTTON = 0
const RIGHT_BUTTON = 2

export type ClickSentListener = (message: ClickMessage) => void

const clickIds = new WeakMap<Event, string>()
const pendingClaims = new Map<string, ClickClaim>()
const clickSentListeners: ClickSentListener[] = []

const MODIFIER_FLAGS: [ModifierKey, 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey'][] = [
  ['shift', 'shiftKey'],
  ['control', 'ctrlKey'],
  ['alt', 'altKey'],
  ['meta', 'metaKey'],
]

function modifierKeysOf(event: MouseEvent): ModifierKey[] {
  return MODIFIER_FLAGS.filter(([, flag]) => event[flag]).map(([key]) => key)
}

function clickTypeOf(event: MouseEvent): ClickType {
  if (event.type === 'contextmenu') {
    return 'right'
  }

  if (event.type === 'click') {
    return 'primary'
  }

  return event.button === 1 ? 'middle' : 'other'
}

function isRecordedAuxClick(event: MouseEvent): boolean {
  return event.button !== PRIMARY_BUTTON && event.button !== RIGHT_BUTTON
}

function linkTextOf(link: Element): string {
  const text = link instanceof HTMLElement ? link.innerText : link.textContent

  return (text ?? '').replace(/\s+/g, ' ').trim().slice(0, LINK_TEXT_LIMIT).trimEnd()
}

function absoluteAddressOf(href: string, doc: Document): string {
  try {
    return new URL(href, doc.baseURI).href
  } catch {
    return href
  }
}

function newClickId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))

  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function linkFieldsOf(link: Element, doc: Document): Partial<ClickMessage> {
  const href = link.getAttribute('href') ?? ''
  const target = link.getAttribute('target')
  const fields: Partial<ClickMessage> = {
    on_link: true,
    link_url: absoluteAddressOf(href, doc),
    link_text: linkTextOf(link),
  }

  if (target !== null && target !== '') {
    fields.link_target = target
  }

  return fields
}

function clickMessageFor(event: MouseEvent, doc: Document): ClickMessage {
  const link = event.target instanceof Element ? event.target.closest('a[href]') : null

  return {
    messageType: 'pageClick',
    click_id: clickIdFor(event),
    url: doc.location.href,
    title: doc.title,
    timestamp: Date.now(),
    click_type: clickTypeOf(event),
    button: event.button,
    modifier_keys: modifierKeysOf(event),
    click_count: Math.max(1, event.detail),
    on_link: false,
    ...(link === null ? {} : linkFieldsOf(link, doc)),
  }
}

export function clickIdFor(event: Event): string {
  const known = clickIds.get(event)

  if (known !== undefined) {
    return known
  }

  const clickId = newClickId()

  clickIds.set(event, clickId)

  return clickId
}

export function claimClick(clickId: string, claim: ClickClaim = {}): void {
  pendingClaims.set(clickId, { ...pendingClaims.get(clickId), ...claim })
}

export function onClickSent(listener: ClickSentListener): () => void {
  clickSentListeners.push(listener)

  return () => {
    const index = clickSentListeners.indexOf(listener)

    if (index !== -1) {
      clickSentListeners.splice(index, 1)
    }
  }
}

function reportClickSent(message: ClickMessage): void {
  for (const listener of [...clickSentListeners]) {
    try {
      listener(message)
    } catch (error: unknown) {
      console.warn('[rex-page-events] click listener failed', error)
    }
  }
}

function withClaim(message: ClickMessage): ClickMessage {
  const claim = pendingClaims.get(message.click_id)

  pendingClaims.delete(message.click_id)

  return claim === undefined ? message : { ...message, claim }
}

function sendOnceDeferred(send: (message: ClickMessage) => void, message: ClickMessage, view: Window): void {
  let sent = false

  const sendNow = () => {
    if (sent) {
      return
    }

    sent = true
    view.removeEventListener('pagehide', sendNow)

    const sentMessage = withClaim(message)

    send(sentMessage)
    reportClickSent(sentMessage)
  }

  setTimeout(sendNow, 0)
  view.addEventListener('pagehide', sendNow)
}

export function watchClicks(send: (message: ClickMessage) => void, doc: Document): void {
  const view = doc.defaultView

  if (view === null) {
    return
  }

  const record = (event: MouseEvent) => {
    sendOnceDeferred(send, clickMessageFor(event, doc), view)
  }
  view.addEventListener('click', record, true)
  view.addEventListener('contextmenu', record, true)
  view.addEventListener('auxclick', (event: MouseEvent) => {
    if (isRecordedAuxClick(event)) {
      record(event)
    }
  }, true)
}
