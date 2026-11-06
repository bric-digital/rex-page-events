// @ts-nocheck

import rexPageEventsPlugin, { claimClick, clickIdFor } from '@bric/rex-page-events/browser'

console.log(`Imported ${rexPageEventsPlugin} into the browser context for ${window.location.href}...`)

self['rexPageEventsPlugin'] = rexPageEventsPlugin

const CLAIMED_DESTINATION = 'https://claimed.test/destination'

function claimableTarget(event) {
  return event.target instanceof Element && event.target.closest('.claimable') !== null ? event.target : null
}

function noteClickId(target, clickId) {
  const seen = target.getAttribute('data-click-ids')

  target.setAttribute('data-click-ids', seen === null ? clickId : `${seen} ${clickId}`)
}

document.addEventListener('click', (event) => {
  const target = claimableTarget(event)

  if (target !== null) {
    claimClick(clickIdFor(event), { destination_url: CLAIMED_DESTINATION })
    noteClickId(target, clickIdFor(event))
  }
}, true)

document.addEventListener('contextmenu', (event) => {
  if (claimableTarget(event) !== null) {
    claimClick(clickIdFor(event), { destination_url: CLAIMED_DESTINATION })
  }
}, true)

document.addEventListener('click', (event) => {
  const target = claimableTarget(event)

  if (target !== null) {
    noteClickId(target, clickIdFor(event))
  }
})
