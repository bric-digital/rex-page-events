// @ts-nocheck

import rexPageEventsPlugin from '@bric/rex-page-events/browser'

console.log(`Imported ${rexPageEventsPlugin} into the browser context for ${window.location.href}...`)

self['rexPageEventsPlugin'] = rexPageEventsPlugin
