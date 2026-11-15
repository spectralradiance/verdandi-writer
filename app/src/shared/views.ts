// How a document is shown (PLAN.md §3b, Views): which layer comes first in each
// row, which others show beside it, which sections show, and whether one section
// has the page to itself. A document folder's saved views live in
// `.verdandi/views.yaml`, so they travel with it; the view in use now is kept in
// the app's preferences.

import { parse, stringify } from 'yaml'

/** `output` is the text itself; any other name is one of the document's layers. */
export type ViewKind = string

export type ViewLayout = 'side' | 'stacked'

export interface DocumentView {
  /** The layer each row starts with. */
  primary: ViewKind
  /**
   * The layer shown beside (or under) it: one at a time, chosen from the tabs over
   * the rows. Empty hides the side. (A list, as views saved before the tabs kept
   * several; only the first is used.)
   */
  shown: ViewKind[]
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

export function defaultView(layers: readonly string[]): DocumentView {
  return { primary: 'output', shown: layers.slice(0, 1), layout: 'side', page: null, hidden: [], collapsed: [], filter: {} }
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])

/**
 * A view read from storage, made safe to use: unknown layers dropped, the primary
 * layer one that exists, and everything else given its default.
 */
export function normalizeView(value: unknown, layers: readonly string[]): DocumentView {
  const base = defaultView(layers)
  if (!value || typeof value !== 'object') return base
  const raw = value as Record<string, unknown>
  const kinds = ['output', ...layers]
  const primary = typeof raw.primary === 'string' && kinds.includes(raw.primary) ? raw.primary : 'output'
  const shown = Array.isArray(raw.shown)
    ? strings(raw.shown).filter((kind) => kinds.includes(kind) && kind !== primary).slice(0, 1)
    : base.shown.filter((kind) => kind !== primary)
  const filter: Record<string, string> = {}
  if (raw.filter && typeof raw.filter === 'object' && !Array.isArray(raw.filter)) {
    for (const [field, wanted] of Object.entries(raw.filter as Record<string, unknown>)) {
      if (field.trim() && (typeof wanted === 'string' || typeof wanted === 'number' || typeof wanted === 'boolean')) filter[field.trim()] = String(wanted)
    }
  }
  return {
    primary,
    shown,
    layout: raw.layout === 'stacked' ? 'stacked' : 'side',
    page: typeof raw.page === 'string' && raw.page ? raw.page : null,
    hidden: [...new Set(strings(raw.hidden))],
    collapsed: [...new Set(strings(raw.collapsed))],
    filter,
  }
}

/** Whether two views show the document the same way. */
export function sameView(a: DocumentView, b: DocumentView): boolean {
  const canonical = (view: DocumentView) => JSON.stringify([
    view.primary, view.shown, view.layout, view.page, [...view.hidden].sort(), [...view.collapsed].sort(),
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
    const entry: Record<string, unknown> = { name: view.name, primary: view.primary, shown: view.shown }
    if (view.layout !== 'side') entry.layout = view.layout
    if (view.page) entry.page = view.page
    if (view.hidden.length) entry.hidden = view.hidden
    if (view.collapsed.length) entry.collapsed = view.collapsed
    if (Object.keys(view.filter).length) entry.filter = view.filter
    return entry
  })
  return stringify({ views: entries }, { lineWidth: 0, flowCollectionPadding: false })
}
