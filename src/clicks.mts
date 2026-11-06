import { type ClickMessage, type ClickType, type ModifierKey } from './types.mjs'

const LINK_TEXT_LIMIT = 200
const PRIMARY_BUTTON = 0
const RIGHT_BUTTON = 2

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

function linkFieldsOf(link: Element, doc: Document): Partial<ClickMessage> {
  const href = link.getAttribute('href') ?? ''
  const target = link.getAttribute('target')
  const fields: Partial<ClickMessage> = {
    on_link: true,
    link_url: new URL(href, doc.baseURI).href,
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
    click_id: crypto.randomUUID(),
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

export function watchClicks(send: (message: ClickMessage) => void, doc: Document): void {
  const view = doc.defaultView

  if (view === null) {
    return
  }

  const record = (event: MouseEvent) => {
    send(clickMessageFor(event, doc))
  }

  view.addEventListener('click', record, true)
  view.addEventListener('contextmenu', record, true)
  view.addEventListener('auxclick', (event: MouseEvent) => {
    if (isRecordedAuxClick(event)) {
      record(event)
    }
  }, true)
}
