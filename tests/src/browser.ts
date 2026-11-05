// @ts-nocheck

import rexPageEventsPlugin from '@bric/rex-page-events/browser'

console.log(`Imported ${rexPageEventsPlugin} into the browser context for ${window.location.href}...`)

self['rexPageEventsPlugin'] = rexPageEventsPlugin

document.getElementById('rex_here').innerHTML = `${window.rexClientScriptLoaded}`

console.log(`set rex_here to ${window.rexClientScriptLoaded}`)
