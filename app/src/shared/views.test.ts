import { describe, expect, it } from 'vitest'

import { defaultView, fieldValues, foldColumns, matchesFilter, normalizeView, parseViews, placeLayer, placeOf, renameInView, sameView, showLayer, sideShowing, type ViewColumn, writeViews } from './views'

describe('views', () => {
  it('normalizes a stored view against the document’s layers', () => {
    expect(normalizeView({ primary: 'gone', layout: 'stacked', hidden: ['a'], columns: [{ layers: ['notes', 'notes', 'x'] }] }, ['notes'])).toEqual({
      primary: 'output', under: [], columns: [{ layers: ['notes'], mode: 'tabs', active: 'notes', width: 1 }], sideHidden: false, primaryWidth: 1,
      layout: 'stacked', page: null, hidden: ['a'], collapsed: [], filter: {},
    })
    // Each layer in one place at most; at most two columns; empty ones dropped.
    const view = normalizeView({
      primary: 'notes', under: ['outline', 'notes'],
      columns: [{ layers: ['outline'] }, { layers: ['output', 'research'], mode: 'stack', width: 9 }, { layers: [] }, { layers: ['images'] }],
    }, ['notes', 'outline', 'research', 'images'])
    expect(view.under).toEqual(['outline'])
    expect(view.columns).toEqual([
      { layers: ['output', 'research'], mode: 'stack', active: 'output', width: 4 },
      { layers: ['images'], mode: 'tabs', active: 'images', width: 1 },
    ])
  })

  it('reads views saved before columns', () => {
    // One layer beside the rows: the others are tabs in the same column.
    const old = normalizeView({ shown: ['outline', 'notes'] }, ['notes', 'outline'])
    expect(old.columns).toEqual([{ layers: ['notes', 'outline'], mode: 'tabs', active: 'outline', width: 1 }])
    expect(old.sideHidden).toBe(false)
    expect(normalizeView({ shown: [] }, ['notes']).sideHidden).toBe(true)
    expect(normalizeView({ primary: 'notes' }, ['notes']).columns[0].layers).toEqual(['output'])
    expect(normalizeView(null, []).columns).toEqual([])
  })

  it('places layers', () => {
    const base = normalizeView(null, ['notes', 'outline', 'research'])
    // Made primary, a layer swaps with the old primary.
    const swapped = placeLayer(base, 'outline', { at: 'primary' })
    expect(swapped.primary).toBe('outline')
    expect(swapped.columns[0].layers).toEqual(['notes', 'output', 'research'])
    // A new column, then under the text, then out of the view.
    const two = placeLayer(base, 'research', { at: 'column', index: 1 })
    expect(two.columns.map((column) => column.layers)).toEqual([['notes', 'outline'], ['research']])
    const under = placeLayer(two, 'notes', { at: 'under' })
    expect(under.under).toEqual(['notes'])
    expect(under.columns[0]).toMatchObject({ layers: ['outline'], active: 'outline' })
    const gone = placeLayer(under, 'research', { at: 'none' })
    expect(gone.columns).toHaveLength(1)
    expect(placeOf(gone, 'research')).toEqual({ at: 'none' })
    // Showing a layer that isn't placed puts it in the first column and chooses its tab.
    const shown = showLayer({ ...gone, sideHidden: true }, 'research')
    expect(shown.columns[0]).toMatchObject({ layers: ['outline', 'research'], active: 'research' })
    expect(shown.sideHidden).toBe(false)
    // Before a position, and never a third column.
    expect(placeLayer(two, 'outline', { at: 'column', index: 1 }, 0).columns[1].layers).toEqual(['outline', 'research'])
    expect(placeLayer(two, 'outline', { at: 'column', index: 2 }).columns).toHaveLength(2)
  })

  it('renames and removes layers in a view', () => {
    const view = placeLayer(normalizeView(null, ['notes', 'outline']), 'notes', { at: 'primary' })
    expect(renameInView(view, 'notes', 'beats').primary).toBe('beats')
    const removed = renameInView(view, 'notes', null)
    expect(removed.primary).toBe('output')
    expect(removed.columns.map((column) => column.layers)).toEqual([['outline']])
  })

  it('folds columns into fewer', () => {
    const columns: ViewColumn[] = [
      { layers: ['notes'], mode: 'tabs', active: 'notes', width: 1 },
      { layers: ['outline', 'research'], mode: 'stack', active: 'outline', width: 0.5 },
    ]
    expect(foldColumns(columns, 1)).toEqual([{ layers: ['notes', 'outline', 'research'], mode: 'tabs', active: 'notes', width: 1 }])
    expect(foldColumns(columns, 2)).toEqual(columns)
    expect(sideShowing(columns)).toEqual([['notes'], ['outline', 'research']])
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
    expect(views).toEqual([{ name: 'All', ...defaultView(['notes']), collapsed: ['x'], filter: { tags: 'act-1' } }])
    const arranged = { name: 'Plan', ...placeLayer(placeLayer(normalizeView(null, ['notes', 'outline']), 'outline', { at: 'column', index: 1 }), 'notes', { at: 'under' }), primaryWidth: 1.5 }
    expect(parseViews(writeViews([arranged]), ['notes', 'outline'])).toEqual([arranged])
    expect(sameView(views[0], { ...views[0], sideHidden: true })).toBe(true)
    expect(parseViews('views: [{name: ""}, 3, {name: A}, {name: A}]', [])).toHaveLength(1)
    expect(parseViews(':::', [])).toEqual([])
    expect(sameView(views[0], { ...views[0], collapsed: ['x'] })).toBe(true)
    expect(sameView(views[0], { ...views[0], layout: 'stacked' })).toBe(false)
  })
})
