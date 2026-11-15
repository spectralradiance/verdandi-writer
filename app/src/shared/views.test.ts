import { describe, expect, it } from 'vitest'

import { fieldValues, matchesFilter, normalizeView, parseViews, sameView, writeViews } from './views'

describe('views', () => {
  it('normalizes a stored view against the document’s layers', () => {
    expect(normalizeView({ primary: 'gone', shown: ['notes', 'notes', 'x'], layout: 'stacked', hidden: ['a'] }, ['notes'])).toEqual({
      primary: 'output', shown: ['notes'], layout: 'stacked', page: null, hidden: ['a'], collapsed: [], filter: {},
    })
    expect(normalizeView(null, ['notes', 'outline']).shown).toEqual(['notes'])
    expect(normalizeView({ primary: 'notes' }, ['notes']).shown).toEqual([])
  })

  it('matches fields, lists and presence', () => {
    const fields = { Status: 'Draft', tags: ['act-1', 'act-2'], pov: '' }
    expect(matchesFilter(fields, {})).toBe(true)
    expect(matchesFilter(fields, { status: 'draft' })).toBe(true)
    expect(matchesFilter(fields, { tags: 'act-2', status: 'draft' })).toBe(true)
    expect(matchesFilter(fields, { tags: 'act-3' })).toBe(false)
    expect(matchesFilter(fields, { pov: '' })).toBe(false)
    expect(matchesFilter(fields, { status: '' })).toBe(true)
    expect(matchesFilter(undefined, { status: 'draft' })).toBe(false)
  })

  it('collects the values each field takes', () => {
    expect([...fieldValues([{ tags: ['b', 'a'] }, { tags: 'a', status: 'done' }])]).toEqual([['status', ['done']], ['tags', ['a', 'b']]])
  })

  it('round-trips saved views, skipping unreadable ones', () => {
    const views = parseViews(writeViews([{ name: 'All', ...normalizeView({ collapsed: ['x'], filter: { tags: 'act-1' } }, ['notes']) }]), ['notes'])
    expect(views).toEqual([{ name: 'All', primary: 'output', shown: ['notes'], layout: 'side', page: null, hidden: [], collapsed: ['x'], filter: { tags: 'act-1' } }])
    expect(parseViews('views: [{name: ""}, 3, {name: A}, {name: A}]', [])).toHaveLength(1)
    expect(parseViews(':::', [])).toEqual([])
    expect(sameView(views[0], { ...views[0], collapsed: ['x'] })).toBe(true)
    expect(sameView(views[0], { ...views[0], layout: 'stacked' })).toBe(false)
  })
})
