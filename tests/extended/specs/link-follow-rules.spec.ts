// @ts-nocheck

import { test, expect } from './fixtures.js'

const WINDOW_MS = 5000

function click(overrides = {}) {
  return {
    clickId: 'c1',
    tabId: 1,
    windowId: 10,
    sourceUrl: 'https://a.example/results',
    clickedAtMs: 1000,
    linkUrl: 'https://b.example/page',
    claimed: true,
    shiftHeld: false,
    ...overrides,
  }
}

function call(serviceWorker, name, args) {
  return serviceWorker.evaluate(({ name, args }) => self.linkFollow[name](...args), { name, args })
}

test.describe('matchSameTab', () => {
  const match = (serviceWorker, pending, toUrl, atMs, fromUrl = 'https://a.example/results') =>
    call(serviceWorker, 'matchSameTab', [pending, 1, fromUrl, toUrl, atMs, WINDOW_MS])

  test('matches at exactly the window and not one millisecond later', async ({ serviceWorker }) => {
    const pending = [click()]

    expect((await match(serviceWorker, pending, 'https://b.example/page', 6000))?.clickId).toBe('c1')
    expect(await match(serviceWorker, pending, 'https://b.example/page', 6001)).toBeNull()
  })

  test('does not match a navigation before the click', async ({ serviceWorker }) => {
    expect(await match(serviceWorker, [click()], 'https://b.example/page', 999)).toBeNull()
  })

  test('does not match a click in another tab', async ({ serviceWorker }) => {
    expect(await match(serviceWorker, [click({ tabId: 2 })], 'https://b.example/page', 2000)).toBeNull()
  })

  test('returns null for a fragment-only change', async ({ serviceWorker }) => {
    const result = await match(serviceWorker, [click()], 'https://a.example/results#top', 2000)

    expect(result).toBeNull()
  })

  test('a different path with the same fragment is not fragment-only', async ({ serviceWorker }) => {
    const result = await match(serviceWorker, [click()], 'https://a.example/other#top', 2000, 'https://a.example/results#top')

    expect(result?.clickId).toBe('c1')
  })

  test('the latest of two pending clicks wins', async ({ serviceWorker }) => {
    const pending = [click({ clickId: 'late', clickedAtMs: 3000 }), click({ clickId: 'early', clickedAtMs: 1000 })]

    expect((await match(serviceWorker, pending, 'https://b.example/page', 4000))?.clickId).toBe('late')
  })
})

test.describe('isFragmentOnlyChange', () => {
  test('true only when addresses are equal without fragments and the fragments differ', async ({ serviceWorker }) => {
    const cases = [
      ['https://a.example/p', 'https://a.example/p#x', true],
      ['https://a.example/p#x', 'https://a.example/p#y', true],
      ['https://a.example/p#x', 'https://a.example/p', true],
      ['https://a.example/p#x', 'https://a.example/p#x', false],
      ['https://a.example/p', 'https://a.example/p', false],
      ['https://a.example/p', 'https://a.example/q#x', false],
    ]

    for (const [from, to, expected] of cases) {
      expect(await call(serviceWorker, 'isFragmentOnlyChange', [from, to]), `${from} -> ${to}`).toBe(expected)
    }
  })
})

test.describe('matchNewTab', () => {
  const matchTab = (serviceWorker, pending, tab, atMs = 2000, windowCreatedAtMs = undefined) =>
    call(serviceWorker, 'matchNewTab', [pending, tab, atMs, WINDOW_MS, windowCreatedAtMs])

  test('opener in the same window is a new tab', async ({ serviceWorker }) => {
    const result = await matchTab(serviceWorker, [click()], { openerTabId: 1, windowId: 10 })

    expect(result).toEqual({ click: click(), openMode: 'new_tab', matchedBy: 'opener' })
  })

  test('opener in another window is a new window', async ({ serviceWorker }) => {
    const result = await matchTab(serviceWorker, [click()], { openerTabId: 1, windowId: 11 })

    expect(result?.openMode).toBe('new_window')
    expect(result?.matchedBy).toBe('opener')
  })

  test('a burst of three tabs matches each to its own click by pendingUrl', async ({ serviceWorker }) => {
    const pending = [
      click({ clickId: 'one', clickedAtMs: 1000, linkUrl: 'https://b.example/1' }),
      click({ clickId: 'two', clickedAtMs: 1010, linkUrl: 'https://b.example/2' }),
      click({ clickId: 'three', clickedAtMs: 1020, linkUrl: 'https://b.example/3' }),
    ]
    const matched = []

    for (const n of ['3', '1', '2']) {
      const result = await matchTab(serviceWorker, pending, { openerTabId: 1, windowId: 10, pendingUrl: `https://b.example/${n}` })

      matched.push(result?.click.clickId)
    }

    expect(matched).toEqual(['three', 'one', 'two'])
  })

  test('a burst of claimed redirect links matches each tab to its own click by pendingUrl', async ({ serviceWorker }) => {
    const redirect = (n, clickedAtMs) =>
      click({
        clickId: `r${n}`,
        clickedAtMs,
        linkUrl: `https://g.example/goto?url=${n}`,
        claimDestinationUrl: `https://b.example/${n}`,
      })
    const pending = [redirect(1, 1000), redirect(2, 1010), redirect(3, 1020)]
    const matched = []

    for (const n of ['3', '1', '2']) {
      const result = await matchTab(serviceWorker, pending, { openerTabId: 1, windowId: 10, pendingUrl: `https://g.example/goto?url=${n}` })

      matched.push(result?.click.clickId)
    }

    expect(matched).toEqual(['r3', 'r1', 'r2'])
  })

  test('a tab addressed at the claimed destination matches its click', async ({ serviceWorker }) => {
    const redirect = (n, clickedAtMs) =>
      click({
        clickId: `r${n}`,
        clickedAtMs,
        linkUrl: `https://g.example/goto?url=${n}`,
        claimDestinationUrl: `https://b.example/${n}`,
      })
    const pending = [redirect(1, 1000), redirect(2, 1010)]

    const result = await matchTab(serviceWorker, pending, { openerTabId: 1, windowId: 10, pendingUrl: 'https://b.example/1' })

    expect(result?.click.clickId).toBe('r1')
  })

  test('no pending click from the opener tab does not match', async ({ serviceWorker }) => {
    expect(await matchTab(serviceWorker, [click()], { openerTabId: 2, windowId: 10 })).toBeNull()
  })

  test('opener match outside the window does not match', async ({ serviceWorker }) => {
    expect(await matchTab(serviceWorker, [click()], { openerTabId: 1, windowId: 10 }, 6001)).toBeNull()
  })

  test.describe('without an opener', () => {
    const shiftClick = click({ shiftHeld: true })
    const tab = { windowId: 11, pendingUrl: 'https://b.example/page' }

    test('a Shift-click matches by address and time', async ({ serviceWorker }) => {
      const result = await matchTab(serviceWorker, [shiftClick], tab, 2000, 1500)

      expect(result).toEqual({ click: shiftClick, openMode: 'new_window', matchedBy: 'address_and_time' })
    })

    test('a claimed redirect link Shift-clicked into a new window matches by its link address', async ({ serviceWorker }) => {
      const redirect = click({
        shiftHeld: true,
        linkUrl: 'https://g.example/goto?url=1',
        claimDestinationUrl: 'https://b.example/1',
      })
      const result = await matchTab(serviceWorker, [redirect], { windowId: 11, pendingUrl: 'https://g.example/goto?url=1' }, 2000, 1500)

      expect(result).toEqual({ click: redirect, openMode: 'new_window', matchedBy: 'address_and_time' })
    })

    test('a claimed redirect link matches by its claimed destination too', async ({ serviceWorker }) => {
      const redirect = click({
        shiftHeld: true,
        linkUrl: 'https://g.example/goto?url=1',
        claimDestinationUrl: 'https://b.example/1',
      })
      const result = await matchTab(serviceWorker, [redirect], { windowId: 11, pendingUrl: 'https://b.example/1' }, 2000, 1500)

      expect(result?.matchedBy).toBe('address_and_time')
    })

    test('matches by the tab address when there is no pending address', async ({ serviceWorker }) => {
      const result = await matchTab(serviceWorker, [shiftClick], { windowId: 11, url: 'https://b.example/page' }, 2000, 1500)

      expect(result?.matchedBy).toBe('address_and_time')
    })

    test('control: without Shift it does not match', async ({ serviceWorker }) => {
      expect(await matchTab(serviceWorker, [click()], tab, 2000, 1500)).toBeNull()
    })

    test('control: another address does not match', async ({ serviceWorker }) => {
      const other = { windowId: 11, pendingUrl: 'https://c.example/page' }

      expect(await matchTab(serviceWorker, [shiftClick], other, 2000, 1500)).toBeNull()
    })

    test('control: a window created after the match window does not match', async ({ serviceWorker }) => {
      expect(await matchTab(serviceWorker, [shiftClick], tab, 7000, 6001)).toBeNull()
    })

    test('control: no window creation time does not match', async ({ serviceWorker }) => {
      expect(await matchTab(serviceWorker, [shiftClick], tab, 2000)).toBeNull()
    })
  })
})

test.describe('focusedMsAt', () => {
  test('adds the open focus interval to the accumulated duration', async ({ serviceWorker }) => {
    expect(await call(serviceWorker, 'focusedMsAt', [1500, 10000, 10400])).toBe(1900)
  })

  test('returns the accumulated duration when focus is closed', async ({ serviceWorker }) => {
    expect(await call(serviceWorker, 'focusedMsAt', [1500, null, 10400])).toBe(1500)
  })
})

test.describe('originOf', () => {
  test('returns the origin without path, query or fragment', async ({ serviceWorker }) => {
    expect(await call(serviceWorker, 'originOf', ['https://a.example/p?q#f'])).toBe('https://a.example')
  })

  test('returns undefined for text that is not an address', async ({ serviceWorker }) => {
    expect(await call(serviceWorker, 'originOf', ['not an address'])).toBeUndefined()
  })
})
