# rex-page-events

REX module that records page, tab, and window lifecycle events and transmits them through the REX event bus (so downstream modules like `rex-passive-data-kit` and `rex-local-download` persist them).

## Overview

**rex-page-events** tracks when pages appear, disappear, gain focus, lose focus, when tabs open/navigate/close, and when browser windows close. Each observation produces a single event dispatched via `dispatchEvent` in rex-core. URLs can be redacted against lists managed by `rex-lists`, so sensitive sites can be tracked for **dwell time** without capturing the URL or page title.

- Records page_show / page_hide / tab_focus / tab_blur / load / scroll (from content scripts)
- Records tab_open / tab_url_change / tab_close / window_close (from the service worker)
- Per-tab session_id (UUID) minted at tab_open, carried on every subsequent event for that tab
- `tab_close` events carry `tab_lifetime_ms` and `focus_duration_ms` (accumulated time the tab was actually focused)
- URL redaction via allow/filter/domain_only lists (same semantics as `rex-history`) — redacted events still record dwell time

## Event Schema

Every event shares the name `rex-page-event` and is distinguished by `event_type`. There are ten event types in the current implementation.

| `event_type` | Source | Notes |
|---|---|---|
| `tab_open` | `chrome.tabs.onCreated` | Mints a new per-tab `session_id` |
| `tab_url_change` | `chrome.tabs.onUpdated` (with `changeInfo.url`) | Records in-tab navigation |
| `tab_focus` | `chrome.tabs.onActivated` + `chrome.windows.onFocusChanged` | Starts the focus clock |
| `tab_blur` | Same listeners, losing focus | Accumulates into `focus_duration_ms` |
| `page_show` | Content-script `window.pageshow` | Includes bfcache `persisted` flag |
| `page_hide` | Content-script `window.pagehide` | Includes bfcache `persisted` flag |
| `tab_close` | `chrome.tabs.onRemoved` | Carries `tab_lifetime_ms` and `focus_duration_ms` |
| `window_close` | `chrome.windows.onRemoved` | Emitted once per window close |
| `load` | Content-script `window.load`, or Navigation Timing when the script arrives after load | Once per document, at the time `load` began |
| `scroll` | Content-script `window.scroll`, after a 250 ms pause | Also at the start, on leaving during a pause, and on return from the bfcache |

### Where each field comes from

| Field | Source |
|---|---|
| `name` | Hardcoded: `"rex-page-event"` for every event |
| `event_type` | One of the ten types in the table above |
| `session_id` | `crypto.randomUUID()` — minted once on `tab_open` (or on first observed event for a tab whose `onCreated` was missed), then attached to every subsequent event for that tab |
| `tab_id` | `chrome.tabs.*` listeners (the active listener's `tabId` argument), or `sender.tab.id` for content-script-originated events |
| `window_id` | Same listeners / `sender.tab.windowId` |
| `url` | For service-worker events: the `chrome.tabs.Tab` handed to the listener. For content-script events (`page_show`, `page_hide`, `tab_focus`, `tab_blur`, `load`, `scroll`): `location.href` captured in the page context. May be replaced by a redaction token — see **Redaction** below. |
| `title` | Same two sources as `url` (`tab.title` in the service worker, `document.title` in the page). Omitted entirely when the URL is redacted by an allow- or filter-list. |
| `timestamp`, `date` | `Date.now()`, captured once per event and assigned to both fields (PDK expects `date`; we also surface it under `timestamp` for clarity). For `load`, the time `load` began (`performance.timeOrigin + loadEventStart`) |
| `filtered` | `true` iff any list matched or the URL failed an allow-list check — see **Redaction** |
| `filtered_by_list` | Present only when `filtered: true`: the list name that caused the redaction (or `"NOT_ON_ALLOWLIST"` for allow-list rejections) |
| `allowed_by_list` | Present only when `allow_lists` is configured and the URL matched one: the allow-list name |
| `persisted` | Only on `page_show` / `page_hide`: the `PageTransitionEvent.persisted` bfcache flag |
| `top`, `left` | Only on `scroll`: `window.scrollY` and `window.scrollX` |
| `width`, `height` | Only on `scroll`: `document.documentElement.clientWidth` and `clientHeight`, the visible area |
| `document_height`, `document_width` | Only on `scroll`: `document.documentElement.scrollHeight` and `scrollWidth`, the full page, so scroll depth can be computed in both directions |
| `url_shown_at` | Present on **every** event: the `Date.now()` when the event's `url` became active in this tab. Reset on every `tab_url_change` (to `now`) and minted fresh at `tab_open`. This is the **deterministic join key** against `rex-history-visit.visit_time`. |
| `url_focus_duration_ms` | On `tab_url_change` and `tab_close`: ms the user had *this specific URL* focused in this tab. Per-URL, not per-tab — reset on every `tab_url_change`. |
| `url_dwell_ms` | On `tab_url_change` and `tab_close`: wall-clock ms the URL was the active URL in this tab (regardless of focus). Useful for differentiating "tab in background for an hour" from "user actively reading." |
| `previous_url` | Only on `tab_url_change`: the URL that preceded the outgoing `url` in this same tab (i.e. two hops of in-tab history). Absent on the first `tab_url_change` of a tab. Subject to the same redaction rules as `url`. |
| `previous_url_filtered` | Only on `tab_url_change` when `previous_url` is present: `true` iff `previous_url` was redacted by the list rules. Independent of the top-level `filtered` (which describes `url`). |
| `opener_tab_id` | Only on `tab_open` when Chrome reports an opener tab (middle-click, `target="_blank"`, `window.open`, Ctrl/Cmd-click, "Open link in new tab"): the tab id that spawned this tab. Absent for tabs opened from the address bar, bookmarks, new-tab button, session restore, or an external application. |
| `opener_url` | Only on `tab_open` when `opener_tab_id` is present **and** this module has state for the opener tab: the opener tab's current URL at the moment the new tab was created. Subject to the same redaction rules as `url`. |
| `opener_filtered` | Only on `tab_open` when `opener_url` is present: `true` iff `opener_url` was redacted by the list rules. Independent of the top-level `filtered` (which describes `url`). |
| `tab_lifetime_ms` | Only on `tab_close`: wall-clock ms between `tab_open` and the close event |
| `focus_duration_ms` | Only on `tab_close`: accumulated ms the tab was focused **across its entire lifetime** (all URL segments combined). Sum of every segment's `url_focus_duration_ms`. |
| `is_window_closing` | Only on `tab_close`: the `isWindowClosing` flag from `chrome.tabs.onRemoved`'s `removeInfo` — `true` when the tab closed because its window did |
| `window_id` (on `window_close`) | From `chrome.windows.onRemoved` |

### Example records

**`tab_open`** — a new tab appears. `url_shown_at` equals `timestamp` because the URL just became active. When Chrome reports an opener tab (e.g. middle-click on a link), `opener_tab_id` / `opener_url` / `opener_filtered` are included — see **Cross-tab referral linkage** below:

```json
{
  "name": "rex-page-event",
  "event_type": "tab_open",
  "session_id": "b4e9f1a2-3c5d-4e7a-9b1c-8d2e0f3a4b5c",
  "tab_id": 8473,
  "window_id": 12,
  "url": "https://www.cnbc.com/2026/04/18/fed-rate-decision-markets.html",
  "title": "",
  "url_shown_at": 1745172500000,
  "opener_tab_id": 8472,
  "opener_url": "https://news.ycombinator.com/",
  "opener_filtered": false,
  "timestamp": 1745172500000,
  "date": 1745172500000,
  "filtered": false
}
```

**`tab_focus`** / **`tab_blur`** — focus transitions on an already-open tab. `url_shown_at` stays pinned to when the URL became active:

```json
{
  "name": "rex-page-event",
  "event_type": "tab_focus",
  "session_id": "b4e9f1a2-3c5d-4e7a-9b1c-8d2e0f3a4b5c",
  "tab_id": 8472,
  "window_id": 12,
  "url": "https://www.cnbc.com/2026/04/18/fed-rate-decision-markets.html",
  "title": "Fed holds rates steady as markets wobble",
  "url_shown_at": 1745172463812,
  "timestamp": 1745172471002,
  "date": 1745172471002,
  "filtered": false
}
```

**`tab_url_change`** — a **segment-flush event**: the payload describes the *outgoing* URL (so it can be linked back to the corresponding `rex-history-visit`). After this event, a new URL segment begins and a new internal `rex-page-url-active` record is delivered for the incoming URL. `previous_url` is the URL that preceded the outgoing one in this same tab; it is absent on a tab's first `tab_url_change`.

```json
{
  "name": "rex-page-event",
  "event_type": "tab_url_change",
  "session_id": "b4e9f1a2-3c5d-4e7a-9b1c-8d2e0f3a4b5c",
  "tab_id": 8472,
  "window_id": 12,
  "url": "https://www.cnbc.com/2026/04/18/fed-rate-decision-markets.html",
  "title": "Fed holds rates steady as markets wobble",
  "url_shown_at": 1745172463812,
  "url_focus_duration_ms": 62300,
  "url_dwell_ms": 87414,
  "previous_url": "https://www.cnbc.com/markets",
  "previous_url_filtered": false,
  "timestamp": 1745172551226,
  "date": 1745172551226,
  "filtered": false
}
```

**`page_show`** — content-script lifecycle event (carries `persisted`):

```json
{
  "name": "rex-page-event",
  "event_type": "page_show",
  "session_id": "b4e9f1a2-3c5d-4e7a-9b1c-8d2e0f3a4b5c",
  "tab_id": 8472,
  "window_id": 12,
  "url": "https://www.cnbc.com/2026/04/18/fed-rate-decision-markets.html",
  "title": "Fed holds rates steady as markets wobble",
  "url_shown_at": 1745172463812,
  "timestamp": 1745172463950,
  "date": 1745172463950,
  "filtered": false,
  "persisted": false
}
```

**`tab_close`** — carries lifetime dwell fields AND the final URL segment's dwell fields. For a tab that only ever visited one URL, `focus_duration_ms === url_focus_duration_ms` and `tab_lifetime_ms === url_dwell_ms`. For a tab that navigated multiple times, the lifetime fields sum across all segments and the url-prefixed fields describe only the final segment:

```json
{
  "name": "rex-page-event",
  "event_type": "tab_close",
  "session_id": "b4e9f1a2-3c5d-4e7a-9b1c-8d2e0f3a4b5c",
  "tab_id": 8472,
  "window_id": 12,
  "url": "https://www.cnbc.com/2026/04/18/fed-rate-decision-markets.html",
  "title": "Fed holds rates steady as markets wobble",
  "url_shown_at": 1745172463812,
  "timestamp": 1745172551226,
  "date": 1745172551226,
  "filtered": false,
  "tab_lifetime_ms": 87414,
  "focus_duration_ms": 62300,
  "url_focus_duration_ms": 62300,
  "url_dwell_ms": 87414,
  "is_window_closing": false
}
```

**Redacted `tab_close`** — URL matched a filter list. URL becomes the category token, `title` is absent, but every dwell field is still present:

```json
{
  "name": "rex-page-event",
  "event_type": "tab_close",
  "session_id": "b4e9f1a2-3c5d-4e7a-9b1c-8d2e0f3a4b5c",
  "tab_id": 8473,
  "window_id": 12,
  "url": "CATEGORY:health",
  "url_shown_at": 1745172606000,
  "timestamp": 1745172660000,
  "date": 1745172660000,
  "filtered": true,
  "filtered_by_list": "sensitive-sites",
  "tab_lifetime_ms": 54000,
  "focus_duration_ms": 41200,
  "url_focus_duration_ms": 41200,
  "url_dwell_ms": 54000,
  "is_window_closing": false
}
```

**`window_close`** — fired once per closed window. `tab_id` is absent because `window_close` has no per-tab context:

```json
{
  "name": "rex-page-event",
  "event_type": "window_close",
  "session_id": "7f2e8a1b-0c9d-4f6a-8e3b-5c1d2a4b6e7f",
  "window_id": 12,
  "url": "",
  "url_shown_at": 1745172551230,
  "timestamp": 1745172551230,
  "date": 1745172551230,
  "filtered": false
}
```

### Redaction

When any of the configured lists match a URL, the **outbound event is still dispatched** — only `url` and `title` on the outbound event are altered. Dwell time is always recorded.

Evaluation order for outbound events:

1. `allow_lists` (if configured and URL matches **none**): `url` → `"CATEGORY:NOT_ON_ALLOWLIST"`, `title` omitted.
2. `filter_lists` (if URL matches any entry): `url` → `"CATEGORY:<category>"`, `title` omitted, `filtered_by_list: "<listName>"`.
3. `domain_only_lists` (if URL matches any entry): `url` → hostname only (e.g. `"example.com"`), `title` → `"DOMAIN ONLY"`, `filtered_by_list: "<listName>"`.
4. Otherwise: raw URL and title pass through.

**Important**: the internal `rex-page-url-active` record delivered to in-process subscribers (see **Linking to rex-history** below) is **never** redacted — it carries the raw URL by design. In default operation that record never leaves the extension. In `debug: true` mode it is additionally dispatched to the event bus, which means it reaches PDK and rex-local-download with the raw URL — do not enable debug in production deployments.

URL fragments are matched **exactly**: `https://a/#x` and `https://a/#y` are treated as different URLs both for event emission and for `rex-page-url-active` delivery.

## Event definitions

BRIC defines load, unload and scroll as follows. Each definition names its source, and changes when one of the conditions under **When a definition changes** applies.

### load

- **Definition:** the page's document has finished loading; recorded once per document.
- **Browser event:** `load` on `window`. If the content script arrives after the page has loaded, the load is recorded at once, with its time read from Navigation Timing (`loadEventStart`), so a late script still records the real load time.
- **Not a load:** a return from the back/forward cache (a `page_show` with `persisted: true`), or a same-document navigation such as `history.pushState`.
- **Limits:** a page left before it finishes loading has no `load`, and neither does a page left before the content script arrives. A page Chrome prerendered (loaded in the background before the participant chose it) records when it finished loading, which may be before the participant saw it; prerendering was not seen on Google results pages searched from the address bar (three searches, 2026-10-26).
- **Sources:** [HTML, "The end"](https://html.spec.whatwg.org/multipage/parsing.html#the-end); [Navigation Timing Level 2](https://w3c.github.io/navigation-timing/).

### unload

- **Definition:** the page stops being shown in its tab. Every `page_hide` is an unload; no separate event type is recorded.
- **Why `page_hide`:** Chrome no longer fires `unload` and recommends `pagehide` instead. On a normal navigation away Chrome usually keeps the page in the back/forward cache, so `page_hide` usually carries `persisted: true`; `persisted: false` means the browser did not keep the page.
- **Limit:** a kept page that the browser discards later produces no further event; a `page_show` with `persisted: true` follows only if the participant returns.
- **Sources:** [HTML, "Unload a document"](https://html.spec.whatwg.org/multipage/document-lifecycle.html#unload-a-document); [Chrome, "Deprecating the unload event"](https://developer.chrome.com/docs/web-platform/deprecating-unload); [web.dev, "Back/forward cache"](https://web.dev/articles/bfcache).

### scroll

- **Definition:** the page's own scroll position once scrolling has paused for 250 ms. Also recorded when the content script starts (the starting position), when the page is left while a record is waiting, and when the page returns from the back/forward cache.
- **Browser event:** `scroll` on `window`, with a timer restarted on every scroll event.
- **Limits:**
  - Only the page's own scroll position; scrolling inside an element with its own scroll bar is not recorded.
  - A position is recorded only after a pause or on leaving, so scrolling down and back up without pausing does not record the furthest point reached. Scroll depth is a lower bound.
  - `width`, `height`, `document_height` and `document_width` are as of the last `scroll` record. Resizing the window, or the page growing as content loads, makes no new record.
  - Scrolls made by the page or the browser, such as a jump to an anchor or a restored position, are recorded like the participant's own.
- **Sources:** [CSSOM View, scrolling](https://drafts.csswg.org/cssom-view/#scrolling-events) and [`scrollX`/`scrollY`](https://drafts.csswg.org/cssom-view/#dom-window-scrollx).

### When a definition changes

- A specification it relies on changes, for example CSSOM View's `scrollend` reaching Recommendation, or HTML changing `pagehide`.
- Chrome or Edge changes how an event fires, as Chrome did with `unload`.
- BRIC sets a different definition for a study.
- Research that BRIC adopts defines the measure differently.

## Cross-tab referral linkage

When a user opens a link in a new tab (middle-click, `target="_blank"`, `window.open`, Ctrl/Cmd-click, "Open link in new tab" context menu), the `tab_open` event carries `opener_tab_id` and — when this module has state for the opener — `opener_url` and `opener_filtered`. `opener_url` is the opener tab's URL **at the moment the new tab was created**. It is recorded once and not revised if the opener subsequently navigates away; that is deliberate, because the referral relationship is defined at the instant of the click.

Known limitations:

- **Cross-profile / incognito openers**: Chrome does not populate `openerTabId` across profile boundaries or from incognito to normal windows (and vice versa). Links opened across that boundary will appear unattributed (no `opener_tab_id`, no `opener_url`). This is a Chrome API constraint and cannot be worked around from within the extension.
- **`rel="noopener"` links**: Chrome's `openerTabId` is still populated even when `rel="noopener"` strips the JavaScript `window.opener` reference. The browser's tab-parent tracking and the page-script opener reference are independent mechanisms, so this module captures `rel="noopener"` links correctly.
- **Opener navigating away**: `opener_url` is captured once at `tab_open` and reflects the opener tab's URL at that instant. If the opener tab navigates away immediately afterward, the recorded `opener_url` is not updated — it remains the URL that actually sent the user to the new tab, which is the analytically correct value.

Cases where `opener_tab_id` will be **absent**: tabs opened from the address bar, bookmarks, the new-tab button, session restore, an external application, or any flow where Chrome itself does not set `openerTabId`.

## Linking to rex-history

`rex-page-events` records focus dwell on a per-tab basis, but a tab can visit many URLs over its lifetime. To give analysts a way to attach focus time to a specific `rex-history-visit` record, this module installs a tiny loose-coupling seam on `globalThis`:

```ts
interface RexPageUrlActiveEvent {
  name: 'rex-page-url-active'
  tab_id: number
  window_id: number
  session_id: string
  url: string           // raw URL, never redacted
  url_shown_at: number  // same timestamp this module reports on every event
}

interface UrlActiveSeam {
  subscribe(listener: (event: RexPageUrlActiveEvent) => void): () => void
}

const seam: UrlActiveSeam | undefined =
  (globalThis as unknown as { __rexPageEventsUrlActive?: UrlActiveSeam }).__rexPageEventsUrlActive
```

Any sibling service-worker module (for example `rex-history`) that wants to join its own records against page-events records can probe for the seam at startup. If it's present, subscribe. If not, proceed without linkage:

```ts
const seam = (globalThis as unknown as { __rexPageEventsUrlActive?: UrlActiveSeam }).__rexPageEventsUrlActive
if (seam?.subscribe) {
  const unsubscribe = seam.subscribe((record) => {
    // buffer or process `record`
  })
  // call unsubscribe() to stop listening
}
```

A record is delivered at `tab_open` and at every `tab_url_change` — so a sibling module can maintain a small `(url, url_shown_at) → { tab_id, window_id, session_id }` lookup table and enrich its own outgoing records when a URL/time pair matches.

## Configuration

This module reads from the `page_events` section of the backend config.

### Schema

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `enabled` | boolean | Yes | — | Enable/disable event recording. If false, no events are dispatched. |
| `filter_lists` | string[] | No | `[]` | Names of `rex-lists` lists whose matching URLs are replaced with `CATEGORY:…`. |
| `allow_lists` | string[] | No | `[]` | If set, URLs not on any listed list are replaced with `CATEGORY:NOT_ON_ALLOWLIST`. |
| `domain_only_lists` | string[] | No | `[]` | Matching URLs are replaced with hostname; title becomes `"DOMAIN ONLY"`. |
| `debug` | boolean | No | `false` | When `true`, `rex-page-url-active` records are additionally dispatched via the REX event bus so PDK and local-download persist them. Raw URLs leave the extension in this mode — use only for development/debugging. |

### Example

```json
{
  "page_events": {
    "enabled": true,
    "filter_lists": ["sensitive-sites"],
    "allow_lists": [],
    "domain_only_lists": ["coarse-domains"],
    "debug": false
  }
}
```

## Coupling model

This module and `rex-history` use **two different kinds of coupling on purpose.**

**Code — loosely coupled.** Neither module imports the other. Neither lists the other in `package.json` dependencies. The only connection is a convention: `rex-page-events` installs a `subscribe` function on `globalThis.__rexPageEventsUrlActive` at service-worker startup, and `rex-history` probes for it at its own startup. If the probe returns undefined (because `rex-page-events` wasn't included in the extension build), `rex-history` proceeds without linkage fields. Either module can ship, update, or be removed independently. The only shared surface is the `RexPageUrlActiveEvent` type in `@bric/rex-types`.

**Data — tightly coupled.** Once both modules are present, every `rex-history-visit` record that matches a buffered `rex-page-url-active` gets `tab_id`, `window_id`, `session_id`, and `page_events_url_shown_at` stapled onto it. A visit's `session_id` means exactly the same thing as the page-event's `session_id` for the same tab lifetime — analysts can treat the two streams as one correlated dataset, joining on `session_id` for exact-within-tab analysis or on `(url, page_events_url_shown_at ≈ visit_time)` for visit-level analysis.

Put simply: loose at the code seam so each module is independently useful, tight at the data seam so the output is analyzable as a single story.

## Installation

Add to your extension's `package.json` dependencies:

```json
{
  "dependencies": {
    "@bric/rex-page-events": "github:bric-digital/rex-page-events#main"
  }
}
```

Then run `npm install`.

In your extension's `browser.ts`:

```ts
await import('@bric/rex-page-events/browser')
```

In your extension's `service-worker.ts`:

```ts
await import('@bric/rex-page-events/service-worker')
```

## Module Context Exports

- `./extension` — Extension UI context (empty; no UI)
- `./browser` — Content-script listeners that forward DOM events to the service worker
- `./service-worker` — Authoritative tab/window lifecycle, redaction, and event dispatch

## Testing

```
npm install
npm test
```

`pretest` bundles the test extension's service worker and browser part; `npm test` then runs the Playwright spec suite under `tests/specs/`:

- `service-worker.spec.ts`: verifies tab_open, tab_url_change (describing the outgoing URL), tab_close lifetime stats, the url-active seam, and that `enabled: false` suppresses events.
- `browser.spec.ts`: loads the browser part through rex-core's own injection and verifies page_hide's `persisted` flag on leaving a page the browser caches and one it does not, `load` when the script arrives before and after load, `scroll` at the start, after a pause, on leaving and on return from the bfcache, and the order of `scroll`, `page_hide` and `tab_close` when a tab is closed. Tests that need the bfcache set the fixture option `backForwardCache`, because Playwright otherwise starts Chromium with it disabled.

Add coverage here when changing behavior.

## Future Considerations

The following signals are intentionally **not** currently captured, to limit payload volume and PII surface:

- **Mouse interactions** (`mousedown`, `mouseup`) — high-frequency, noisy, may need in the future.
- **`DOMContentLoaded` / `readystatechange`**: `load` records when the page finished loading; add these if researchers need the moment parsing finished.
- **`freeze` / `resume` / `visibilitychange`** — partially covered by focus/blur; add if researchers need bfcache-specific signals.

Revisit these when researcher use-cases demand finer-grained signals. If added, keep them behind config flags so existing deployments don't silently grow their payload.

## License

Apache 2.0
