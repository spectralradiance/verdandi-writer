// How a document is shown (PLAN.md §3b, Views): which layer comes first in each
// row, which others show under it and in the columns beside it, which sections
// show, and whether one section has the page to itself. A document folder's saved
// views live in `.verdandi/views.yaml`, so they travel with it; the view in use now
// is kept in the app's preferences.
//
// The layout: the first column holds the primary layer, and any layers put under
// it. Up to two columns sit beside it; each shows its layers one at a time, as tabs
// in the bar over the rows, or all at once, one under another.

import { parse, stringify } from 'yaml'

/** `output` is the text itself; any other name is one of the document's layers. */
export type ViewKind = string

export type ViewLayout = 'side' | 'stacked'

/** A column's layers show one at a time (tabs in the bar) or all at once, stacked. */
export type ColumnMode = 'tabs' | 'stack'

export interface ViewColumn {
  /** The layers in the column, in order. */
  layers: ViewKind[]
  mode: ColumnMode
  /** With tabs, the layer showing (one of `layers`). */
  active: ViewKind | null
  /** Its share of the width, against the first column's `primaryWidth`. */
  width: number
}

export interface DocumentView {
  /** The layer each row starts with. */
  primary: ViewKind
  /** Layers shown under the primary one in the first column, each with its caption. */
  under: ViewKind[]
  /** The columns beside the first (at most `MAX_SIDE_COLUMNS`). A layer in none of them doesn't show. */
  columns: ViewColumn[]
  /** The columns beside the first are put away for now (the bar's button), and come back as they were. */
  sideHidden: boolean
  /** The first column's share of the width. */
  primaryWidth: number
  layout: ViewLayout
  /** One section on a page of its own (its id, or its title in a one-file document), or null for all of them. */
  page: string | null
  /** Sections left out of this view. */
  hidden: string[]
  /** Sections shown as their name only. */
  collapsed: string[]
  /** Only sections whose fields match every entry (`status: draft`, `tags: act-1`). */
  filter: Record<string, string>
}

export interface SavedView extends DocumentView {
  name: string
}

export const VIEWS_FILE = 'views.yaml'
export const MAX_SIDE_COLUMNS = 2
const MIN_WIDTH = 0.25
const MAX_WIDTH = 4

const clampWidth = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(value * 100) / 100)) : 1)

/** The text first, and every layer in one column of tabs beside it. */
export function defaultView(layers: readonly string[]): DocumentView {
  return {
    primary: 'output',
    under: [],
    columns: layers.length ? [{ layers: [...layers], mode: 'tabs', active: layers[0], width: 1 }] : [],
    sideHidden: false,
    primaryWidth: 1,
    layout: 'side',
    page: null,
    hidden: [],
    collapsed: [],
    filter: {},
  }
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])

/**
 * A view read from storage, made safe to use: unknown layers dropped, each layer in
 * one place at most, the primary layer one that exists, and everything else given
 * its default. A view saved before columns (`shown: [notes]`) becomes one column
 * of tabs holding every other layer, with that one showing.
 */
export function normalizeView(value: unknown, layers: readonly string[]): DocumentView {
  const base = defaultView(layers)
  if (!value || typeof value !== 'object') return base
  const raw = value as Record<string, unknown>
  const kinds = ['output', ...layers]
  const primary = typeof raw.primary === 'string' && kinds.includes(raw.primary) ? raw.primary : 'output'
  const used = new Set([primary])
  const take = (list: unknown) => strings(list).filter((kind) => kinds.includes(kind) && !used.has(kind) && used.add(kind))
  const under = take(raw.under)
  let columns: ViewColumn[]
  let sideHidden = raw.sideHidden === true
  if (Array.isArray(raw.columns)) {
    columns = []
    for (const item of raw.columns) {
      if (!item || typeof item !== 'object' || columns.length >= MAX_SIDE_COLUMNS) continue
      const column = item as Record<string, unknown>
      const own = take(column.layers)
      if (own.length === 0) continue
      const active = typeof column.active === 'string' && own.includes(column.active) ? column.active : own[0]
      columns.push({ layers: own, mode: column.mode === 'stack' ? 'stack' : 'tabs', active, width: clampWidth(column.width) })
    }
  } else {
    const others = kinds.filter((kind) => !used.has(kind))
    const shown = strings(raw.shown).filter((kind) => others.includes(kind))
    columns = others.length ? [{ layers: others, mode: 'tabs', active: shown[0] ?? others[0], width: 1 }] : []
    if (Array.isArray(raw.shown) && shown.length === 0) sideHidden = true
  }
  const filter: Record<string, string> = {}
  if (raw.filter && typeof raw.filter === 'object' && !Array.isArray(raw.filter)) {
    for (const [field, wanted] of Object.entries(raw.filter as Record<string, unknown>)) {
      if (field.trim() && (typeof wanted === 'string' || typeof wanted === 'number' || typeof wanted === 'boolean')) filter[field.trim()] = String(wanted)
    }
  }
  return {
    primary,
    under,
    columns,
    sideHidden: sideHidden && columns.length > 0,
    primaryWidth: clampWidth(raw.primaryWidth),
    layout: raw.layout === 'stacked' ? 'stacked' : 'side',
    page: typeof raw.page === 'string' && raw.page ? raw.page : null,
    hidden: [...new Set(strings(raw.hidden))],
    collapsed: [...new Set(strings(raw.collapsed))],
    filter,
  }
}

/** Where a layer can go in a view. */
export type Place = { at: 'primary' } | { at: 'under' } | { at: 'column'; index: number } | { at: 'none' }

/** Where a layer is in a view. */
export function placeOf(view: DocumentView, kind: ViewKind): Place {
  if (view.primary === kind) return { at: 'primary' }
  if (view.under.includes(kind)) return { at: 'under' }
  const index = view.columns.findIndex((column) => column.layers.includes(kind))
  return index >= 0 ? { at: 'column', index } : { at: 'none' }
}

function without(view: DocumentView, kind: ViewKind): DocumentView {
  return {
    ...view,
    under: view.under.filter((item) => item !== kind),
    columns: view.columns.map((column) => {
      const layers = column.layers.filter((item) => item !== kind)
      return { ...column, layers, active: column.active === kind ? layers[0] ?? null : column.active }
    }),
  }
}

const dropEmpty = (view: DocumentView): DocumentView => {
  const columns = view.columns.filter((column) => column.layers.length > 0)
  return { ...view, columns, sideHidden: view.sideHidden && columns.length > 0 }
}

/**
 * Moves a layer to a place in the view (at `position` in a list, else last).
 * Made primary, it swaps with the layer that was: that one takes its place, so
 * switching back and forth keeps both in sight. A column index past the last makes
 * a new column, up to `MAX_SIDE_COLUMNS`.
 */
export function placeLayer(view: DocumentView, kind: ViewKind, place: Place, position?: number): DocumentView {
  const from = placeOf(view, kind)
  if (place.at === 'primary') {
    if (from.at === 'primary') return view
    const old = view.primary
    // The old primary takes the moved layer's place, in the same position.
    const swap = (list: ViewKind[]) => list.map((item) => (item === kind ? old : item))
    return dropEmpty({
      ...view,
      primary: kind,
      under: swap(view.under),
      columns: view.columns.map((column) => ({ ...column, layers: swap(column.layers), active: column.active === kind ? old : column.active })),
    })
  }
  if (from.at === 'primary') return view // the first column always has a primary layer: make another primary instead
  const insert = (list: ViewKind[]) => {
    const next = [...list]
    next.splice(position === undefined ? next.length : Math.max(0, Math.min(position, next.length)), 0, kind)
    return next
  }
  let next = without(view, kind)
  if (place.at === 'under') next = { ...next, under: insert(next.under) }
  if (place.at === 'column') {
    const columns = [...next.columns]
    if (place.index < columns.length) {
      columns[place.index] = { ...columns[place.index], layers: insert(columns[place.index].layers) }
      if (columns[place.index].active === null) columns[place.index] = { ...columns[place.index], active: kind }
    } else if (columns.length < MAX_SIDE_COLUMNS) {
      columns.push({ layers: [kind], mode: 'tabs', active: kind, width: 1 })
    }
    next = { ...next, columns }
  }
  return dropEmpty(next)
}

/**
 * The view changed so that `kind` shows in every row: its tab chosen, the side
 * brought back, or (a layer in no column) added to the first column.
 */
export function showLayer(view: DocumentView, kind: ViewKind): DocumentView {
  const place = placeOf(view, kind)
  if (place.at === 'primary' || place.at === 'under') return view
  let next = place.at === 'none' ? placeLayer(view, kind, { at: 'column', index: 0 }) : view
  const index = next.columns.findIndex((column) => column.layers.includes(kind))
  if (index < 0) return next
  if (next.columns[index].mode === 'tabs' && next.columns[index].active !== kind) {
    next = { ...next, columns: next.columns.map((column, at) => (at === index ? { ...column, active: kind } : column)) }
  }
  return next.sideHidden ? { ...next, sideHidden: false } : next
}

/** A view with a layer renamed (`to` a name) or removed (`to` null). */
export function renameInView(view: DocumentView, from: ViewKind, to: ViewKind | null): DocumentView {
  if (to === null) {
    if (view.primary === from) return dropEmpty(without({ ...view, primary: 'output' }, 'output'))
    return dropEmpty(without(view, from))
  }
  const map = (kind: ViewKind) => (kind === from ? to : kind)
  return {
    ...view,
    primary: map(view.primary),
    under: view.under.map(map),
    columns: view.columns.map((column) => ({ ...column, layers: column.layers.map(map), active: column.active === null ? null : map(column.active) })),
  }
}

/** The layers each row shows beside the first column, by column: a tabs column's showing layer, or a stack's every layer. */
export function sideShowing(columns: readonly ViewColumn[]): ViewKind[][] {
  return columns.map((column) => (column.mode === 'stack' ? [...column.layers] : column.active ? [column.active] : column.layers.slice(0, 1)))
}

/**
 * The columns folded to fit `count` at most: the later ones join the last one kept,
 * as more tabs (a stack joining tabs becomes tabs). It is as wide as the widest of
 * them, so the first column keeps its room.
 */
export function foldColumns(columns: readonly ViewColumn[], count: number): ViewColumn[] {
  if (columns.length <= Math.max(1, count)) return [...columns]
  const keep = columns.slice(0, Math.max(1, count) - 1)
  const rest = columns.slice(keep.length)
  const merged: ViewColumn = {
    layers: rest.flatMap((column) => column.layers),
    mode: 'tabs',
    active: rest[0].mode === 'tabs' ? rest[0].active : rest[0].layers[0],
    width: Math.max(...rest.map((column) => column.width)),
  }
  return [...keep, merged]
}

/** Whether two views show the document the same way. */
export function sameView(a: DocumentView, b: DocumentView): boolean {
  // Which tab is showing and whether the side is put away are left out: they change in passing.
  const canonical = (view: DocumentView) => JSON.stringify([
    view.primary, view.under, view.columns.map((column) => [column.layers, column.mode, column.width]), view.primaryWidth,
    view.layout, view.page, [...view.hidden].sort(), [...view.collapsed].sort(),
    Object.entries(view.filter).sort(([x], [y]) => x.localeCompare(y)),
  ])
  return canonical(a) === canonical(b)
}

const scalar = (value: unknown) => String(value).trim().toLowerCase()

/**
 * Whether a section's fields match a view's filter. A field whose value is a list
 * matches when any item does; an empty wanted value matches any section that has
 * the field at all.
 */
export function matchesFilter(fields: Record<string, unknown> | undefined, filter: Record<string, string>): boolean {
  const entries = Object.entries(filter)
  if (entries.length === 0) return true
  if (!fields) return false
  return entries.every(([field, wanted]) => {
    const key = Object.keys(fields).find((name) => name.toLowerCase() === field.toLowerCase())
    if (key === undefined) return false
    const value = fields[key]
    if (!wanted.trim()) return value !== null && value !== undefined && value !== ''
    const values = Array.isArray(value) ? value : [value]
    return values.some((item) => item !== null && typeof item !== 'object' && scalar(item) === scalar(wanted))
  })
}

/** Fields and the values sections give them, for choosing a filter. */
export function fieldValues(sections: Iterable<Record<string, unknown>>): Map<string, string[]> {
  const found = new Map<string, Set<string>>()
  for (const fields of sections) {
    for (const [field, value] of Object.entries(fields)) {
      const values = found.get(field) ?? new Set<string>()
      found.set(field, values)
      for (const item of Array.isArray(value) ? value : [value]) {
        if (item !== null && item !== undefined && typeof item !== 'object' && String(item).trim()) values.add(String(item).trim())
      }
    }
  }
  return new Map([...found].sort(([a], [b]) => a.localeCompare(b)).map(([field, values]) => [field, [...values].sort((a, b) => a.localeCompare(b))]))
}

/** The saved views in a `views.yaml`. Anything unreadable is skipped rather than lost silently on the next save. */
export function parseViews(text: string, layers: readonly string[]): SavedView[] {
  let data: unknown
  try {
    data = parse(text)
  } catch {
    return []
  }
  const list = data && typeof data === 'object' && Array.isArray((data as { views?: unknown }).views) ? (data as { views: unknown[] }).views : []
  const views: SavedView[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const name = (item as { name?: unknown }).name
    if (typeof name !== 'string' || !name.trim() || views.some((view) => view.name === name.trim())) continue
    views.push({ name: name.trim(), ...normalizeView(item, layers) })
  }
  return views
}

/** A `views.yaml` for `views`, leaving out what is at its default so the file stays short. */
export function writeViews(views: readonly SavedView[]): string {
  const entries = views.map((view) => {
    const entry: Record<string, unknown> = { name: view.name, primary: view.primary }
    if (view.under.length) entry.under = view.under
    entry.columns = view.columns.map((column) => {
      const item: Record<string, unknown> = { layers: column.layers }
      if (column.mode !== 'tabs') item.mode = column.mode
      if (column.mode === 'tabs' && column.active && column.active !== column.layers[0]) item.active = column.active
      if (column.width !== 1) item.width = column.width
      return item
    })
    if (view.sideHidden) entry.sideHidden = true
    if (view.primaryWidth !== 1) entry.primaryWidth = view.primaryWidth
    if (view.layout !== 'side') entry.layout = view.layout
    if (view.page) entry.page = view.page
    if (view.hidden.length) entry.hidden = view.hidden
    if (view.collapsed.length) entry.collapsed = view.collapsed
    if (Object.keys(view.filter).length) entry.filter = view.filter
    return entry
  })
  return stringify({ views: entries }, { lineWidth: 0, flowCollectionPadding: false })
}
