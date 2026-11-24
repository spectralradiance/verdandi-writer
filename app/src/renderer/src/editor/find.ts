// Find and replace in one editor, driven from the floating find box (FindBox.tsx)
// rather than CodeMirror's own search panel: every match is highlighted, the
// current one more strongly, and the box shows "3 of 12".

import { findNext, findPrevious, replaceAll, replaceNext, SearchQuery, setSearchQuery } from '@codemirror/search'
import { type EditorState, StateEffect, StateField } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view'

export interface FindQuery {
  text: string
  caseSensitive: boolean
  wholeWord: boolean
  regexp: boolean
}

export interface FindResult {
  /** Matches in the editor (counted up to `MATCH_LIMIT`). */
  total: number
  /** Which match is selected, from 1; 0 when the selection is on none. */
  current: number
  /** The query can't be searched for (an unfinished regular expression). */
  invalid: boolean
}

/** Past this many matches the count stops, and only the first are highlighted. */
export const MATCH_LIMIT = 5000

const setFind = StateEffect.define<SearchQuery | null>()

const matchMark = Decoration.mark({ class: 'cm-find-match' })
const currentMark = Decoration.mark({ class: 'cm-find-match cm-find-current' })

interface FindState {
  query: SearchQuery | null
  marks: DecorationSet
}

function matches(state: EditorState, query: SearchQuery): { from: number; to: number }[] {
  const found: { from: number; to: number }[] = []
  const cursor = query.getCursor(state)
  for (let next = cursor.next(); !next.done && found.length < MATCH_LIMIT; next = cursor.next()) {
    if (next.value.to > next.value.from) found.push({ from: next.value.from, to: next.value.to })
  }
  return found
}

function decorate(state: EditorState, query: SearchQuery | null): DecorationSet {
  if (!query || !query.valid) return Decoration.none
  const { from, to } = state.selection.main
  return Decoration.set(matches(state, query).map((match) => (match.from === from && match.to === to ? currentMark : matchMark).range(match.from, match.to)))
}

const findField = StateField.define<FindState>({
  create: () => ({ query: null, marks: Decoration.none }),
  update(value, transaction) {
    let query = value.query
    for (const effect of transaction.effects) if (effect.is(setFind)) query = effect.value
    if (query === value.query && !transaction.docChanged && !transaction.selection) return value
    return { query, marks: decorate(transaction.state, query) }
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.marks),
})

/** The extension an editor needs for `find` and the rest to work. */
export const findExtension = [findField]

const toQuery = (query: FindQuery, replace = '') => new SearchQuery({
  search: query.text, caseSensitive: query.caseSensitive, wholeWord: query.wholeWord, regexp: query.regexp, replace,
})

/** Where the find stands in `view`: the count and which match is selected. */
export function findResult(view: EditorView): FindResult {
  const query = view.state.field(findField, false)?.query ?? null
  if (!query) return { total: 0, current: 0, invalid: false }
  if (!query.valid) return { total: 0, current: 0, invalid: query.search !== '' }
  const found = matches(view.state, query)
  const { from, to } = view.state.selection.main
  return { total: found.length, current: found.findIndex((match) => match.from === from && match.to === to) + 1, invalid: false }
}

/** Highlights every match of `query` in `view`, or clears them (null). */
export function setFindQuery(view: EditorView, query: FindQuery | null): FindResult {
  const search = query && query.text ? toQuery(query) : null
  view.dispatch({ effects: [setFind.of(search), ...(search ? [setSearchQuery.of(search)] : [])] })
  return findResult(view)
}

/** Selects the next (1) or previous (-1) match after the selection, wrapping around, and scrolls to it. */
export function findStep(view: EditorView, direction: 1 | -1): FindResult {
  if (direction === 1) findNext(view)
  else findPrevious(view)
  return findResult(view)
}

/** Replaces the selected match (or selects the next one first), then moves on to the next. */
export function replaceStep(view: EditorView, query: FindQuery, replacement: string): FindResult {
  view.dispatch({ effects: setSearchQuery.of(toQuery(query, replacement)) })
  replaceNext(view)
  return findResult(view)
}

/** Replaces every match; returns how many there were. */
export function replaceEvery(view: EditorView, query: FindQuery, replacement: string): number {
  const before = findResult(view).total
  view.dispatch({ effects: setSearchQuery.of(toQuery(query, replacement)) })
  replaceAll(view)
  return before
}
