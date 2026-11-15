import type { ChangeSet } from '@codemirror/state'
import type { EditorView, KeyBinding } from '@codemirror/view'
import { ChevronLeft, ChevronRight, ChevronsDownUp, ChevronsUpDown, Ellipsis, EyeOff, GripVertical, PanelRightOpen, Rows3 } from 'lucide-react'
import { type CSSProperties, type PointerEvent as ReactPointerEvent, type Ref, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'

import { moveSectionText } from '../../../shared/document'
import { suggestEdits } from '../../../shared/diff'
import { type Layer, layerLabel } from '../../../shared/layers'
import type { LayerNames } from '../../../shared/notes'
import { type DocumentView, matchesFilter } from '../../../shared/views'
import { DropdownMenu, type MenuItem } from '../menu'
import { readPref, writePref } from '../prefs'
import { GalleryCell } from './GalleryCell'
import { MarkdownEditor, type MarkdownEditorHandle, type WordInContext } from './MarkdownEditor'
import {
  applyChange, type CellKind, changedRun, continuedName, deleteSection, fromSectionOffset, isFolderText, joinSections, mergeIntoPrevious, moveSection, partition,
  project, type Projection, renameSection, sectionText, sectionTitle, setSectionHeading, shownLineNumbers, showsPreamble,
  splitSection, toSectionOffset,
} from './sectionModel'

/**
 * The document as rows, one per section. Each row starts with its primary layer
 * (left, or on top when narrow or stacked), as tall as its text unless the writer
 * drags the row taller or shorter. The other layers the view shows sit beside it
 * (or below), each in a panel of its own that fits the row and scrolls. Any layer
 * can be primary: the text, the notes, an outline. The side can be hidden per
 * section or for the whole view.
 *
 * The view (see shared/views.ts) also decides which sections show: some can be
 * hidden or collapsed to their name, a filter on their fields leaves others out,
 * and one section can have the page to itself, all its layers one under another.
 *
 * A section starts at a heading, or at a `<!-- section: Name -->` marker for one
 * that has a name but no heading. Each row has a menu to rename, move, merge or
 * delete its section, and to switch its name between a heading and a name only.
 *
 * Every panel is its own small editor over a projection of its section (see
 * sectionModel), and the file is the sections joined back together.
 */

interface Row {
  id: number
  /** The section's key in views and preferences: its id in a document folder, else its title. */
  key: string
  /** The section text: the file's lines for this section, joined with \n. */
  text: string
  title: string | null
  named: boolean
  heading: boolean
  cells: Record<CellKind, Projection>
}

interface RowMeta {
  id: number
  key: string
  title: string | null
  named: boolean
  /** A document folder's section whose name is a heading in exports. */
  heading: boolean
}

export interface SectionGridProps {
  ref?: Ref<MarkdownEditorHandle>
  path: string
  initialText: string
  /** The document's title (its file name), shown above the first section. */
  title: string
  /** A document folder's layers; null for a one-file document, whose only layer is its notes. */
  layers: readonly Layer[] | null
  /** Which layers show, and which sections. */
  view: DocumentView
  onViewChange: (change: (view: DocumentView) => DocumentView) => void
  /** Each section's fields by id (a document folder's frontmatter), for the view's filter. */
  fields?: Record<string, Record<string, unknown>>
  live: boolean
  focusMode: boolean
  /** Shows the document without letting it be edited (an ordinary note, not a Verdandi document). */
  readOnly?: boolean
  onDocChanged: () => void
  onSave: () => void
  onBlur: () => void
  onFocus?: () => void
  onSelectWord?: (word: WordInContext) => void
  /** Rename, add or delete the document's layers (a document folder only). */
  onManageLayers?: () => void
}

const MIN_ROW_HEIGHT = 56
const NEW_SECTION_NAME = 'New section'
const cellKey = (id: number, kind: CellKind) => `${id}:${kind}`
/** Per-section settings are remembered by key, so they survive reopening the file. */
const titleKey = (title: string | null) => title ?? '\u0000before-first-heading'
const metaOf = ({ id, key, title, named, heading }: Row): RowMeta => ({ id, key, title, named, heading })

/** What a layer is called on screen: the text, or the layer's name. */
export function kindLabel(kind: CellKind): string {
  return layerLabel(kind)
}

function placeholderFor(kind: CellKind): string {
  if (kind === 'output') return 'Write here…'
  if (kind === 'notes') return 'Notes for this section…'
  return `${kindLabel(kind)} for this section…`
}

let nextRowId = 1

function makeRow(
  section: { text: string; title: string | null; named: boolean; heading: boolean; id: string | null },
  kinds: readonly CellKind[], classify: LayerNames, id = nextRowId++,
): Row {
  const cells = {} as Record<CellKind, Projection>
  for (const kind of kinds) cells[kind] = project(section.text, kind, classify)
  return {
    id, key: section.id ?? titleKey(section.title), text: section.text, title: section.title, named: section.named, heading: section.heading, cells,
  }
}

function readRecord<T>(key: string): Record<string, T> {
  try {
    const value: unknown = JSON.parse(readPref(key) ?? '{}')
    return typeof value === 'object' && value !== null ? (value as Record<string, T>) : {}
  } catch {
    return {}
  }
}

function writeRecord(key: string, value: Record<string, unknown>): void {
  writePref(key, Object.keys(value).length ? JSON.stringify(value) : null)
}

export function SectionGrid({
  ref, path, initialText, title, layers, view, onViewChange, fields, live, focusMode, readOnly = false,
  onDocChanged, onSave, onBlur, onFocus, onSelectWord, onManageLayers,
}: SectionGridProps) {
  // The layers are fixed for the grid's life: changing them reloads the document.
  const [model] = useState(() => {
    const names = layers ? layers.map((layer) => layer.name) : ['notes']
    return { kinds: ['output', ...names] as CellKind[], classify: (layers ? names : null) as LayerNames, names }
  })
  const { kinds, classify } = model
  const gallery = layers ? layers.filter((layer) => layer.kind === 'gallery').map((layer) => layer.name) : []
  // Built once; the model and the rendered rows both start from it.
  const [initial] = useState(() => {
    const sections = partition(initialText, classify)
    return { rows: sections.map((section) => makeRow(section, kinds, classify)), preamble: showsPreamble(sections) }
  })
  const rows = useRef<Row[]>(initial.rows)
  const [meta, setMeta] = useState<{ rows: RowMeta[]; preamble: boolean }>(() => ({
    rows: initial.rows.map(metaOf),
    preamble: initial.preamble,
  }))
  const [renaming, setRenaming] = useState<number | null>(null)
  const handles = useRef(new Map<string, MarkdownEditorHandle>())
  /** Work for an editor that is not mounted yet (a hidden side being shown). */
  const pending = useRef(new Map<string, (handle: MarkdownEditorHandle) => void>())
  const active = useRef<{ id: number; kind: CellKind } | null>(null)
  /** While text is set from outside, editors report edits the model already has. */
  const applying = useRef(false)
  const resyncTimer = useRef<number | undefined>(undefined)

  const primary = kinds.includes(view.primary) ? view.primary : 'output'
  const secondaries = view.shown.filter((kind) => kinds.includes(kind) && kind !== primary)
  const secondaryShown = secondaries.length > 0
  const pageMode = view.page !== null

  const heightsKey = `sectionHeights:${path}`
  const visibilityKey = `sectionSecondary:${path}`
  const [heights, setHeights] = useState<Record<string, number>>(() => readRecord<number>(heightsKey))
  const [overrides, setOverrides] = useState<Record<string, boolean>>(() => readRecord<boolean>(visibilityKey))

  const parent = useRef({ onDocChanged, onBlur, onFocus, onSelectWord, onViewChange })
  useLayoutEffect(() => {
    parent.current = { onDocChanged, onBlur, onFocus, onSelectWord, onViewChange }
  })

  // Showing or hiding the side for the whole document resets the per-section choices.
  const lastShown = useRef(secondaryShown)
  useEffect(() => {
    if (lastShown.current === secondaryShown) return
    lastShown.current = secondaryShown
    setOverrides({})
    writeRecord(visibilityKey, {})
  }, [secondaryShown, visibilityKey])

  useEffect(() => () => window.clearTimeout(resyncTimer.current), [])

  const getText = useCallback(() => joinSections(rows.current), [])
  const rowById = (id: number) => rows.current.find((row) => row.id === id)

  const setRowShown = useCallback((key: string, shown: boolean) => {
    setOverrides((current) => {
      const next = { ...current, [key]: shown }
      writeRecord(visibilityKey, next)
      return next
    })
  }, [visibilityKey])

  const setRowHeight = useCallback((key: string, value: number | null) => {
    setHeights((current) => {
      const next = { ...current }
      if (value === null) delete next[key]
      else next[key] = value
      writeRecord(heightsKey, next)
      return next
    })
  }, [heightsKey])

  /** Whether a section shows in the view at all (it may still be collapsed). */
  const inView = useCallback((row: { key: string; title: string | null }, index: number) => {
    if (index === 0 && row.title === null && !meta.preamble) return false
    if (view.page !== null) return row.key === view.page
    if (view.hidden.includes(row.key)) return false
    // Sections not saved yet have no fields to go by, and stay in view.
    if (!fields || !(row.key in fields)) return true
    return matchesFilter(fields[row.key], view.filter)
  }, [meta.preamble, view.page, view.hidden, view.filter, fields])

  /**
   * Runs `work` on a row's editor, first making the view show it if needed: the
   * layer, the side of that section, the section itself (or the hidden preamble row).
   */
  const withCell = useCallback((id: number, kind: CellKind, work: (handle: MarkdownEditorHandle) => void) => {
    const handle = handles.current.get(cellKey(id, kind))
    if (handle) {
      work(handle)
      return
    }
    pending.current.set(cellKey(id, kind), work)
    const index = rows.current.findIndex((candidate) => candidate.id === id)
    const row = rows.current[index]
    if (!row) return
    if (kind !== primary) setRowShown(row.key, true)
    if (index === 0 && row.title === null) setMeta((current) => (current.preamble ? current : { ...current, preamble: true }))
    parent.current.onViewChange((current) => {
      let next = current
      if (kind !== primary && !next.shown.includes(kind)) next = { ...next, shown: [...next.shown, kind] }
      if (next.collapsed.includes(row.key)) next = { ...next, collapsed: next.collapsed.filter((key) => key !== row.key) }
      if (next.page !== null && next.page !== row.key) next = { ...next, page: row.key }
      if (next.hidden.includes(row.key)) next = { ...next, hidden: next.hidden.filter((key) => key !== row.key) }
      if (fields && row.key in fields && !matchesFilter(fields[row.key], next.filter)) next = { ...next, filter: {} }
      return next
    })
  }, [primary, setRowShown, fields])

  /**
   * Splits the text into sections again and lines the rows up with them. Rows whose
   * section is unchanged keep their editors; their text is refreshed only if the way
   * it is shown changed (a heading or block markers were typed).
   */
  const resync = useCallback((text: string, undoable = false) => {
    window.clearTimeout(resyncTimer.current)
    const sections = partition(text, classify)
    const before = rows.current
    const run = changedRun(before.map((row) => row.text), sections.map((section) => section.text))
    const next: Row[] = sections.map((section, index) => {
      let reused: Row | undefined
      if (index < run.start) reused = before[index]
      else if (index >= run.endAfter) reused = before[index - run.endAfter + run.endBefore]
      else if (index < run.endBefore) reused = before[index]
      return makeRow(section, kinds, classify, reused?.id)
    })
    applying.current = true
    try {
      for (const row of next) {
        for (const kind of kinds) {
          const handle = handles.current.get(cellKey(row.id, kind))
          if (!handle || handle.getText() === row.cells[kind].text) continue
          if (undoable) handle.replaceAll(row.cells[kind].text)
          else handle.sync(row.cells[kind].text)
        }
      }
    } finally {
      applying.current = false
    }
    rows.current = next
    const changed = next.length !== before.length
      || next.some((row, index) => row.id !== before[index].id || row.key !== before[index].key || row.title !== before[index].title
        || row.named !== before[index].named || row.heading !== before[index].heading)
    const preamble = showsPreamble(sections)
    setMeta((current) => (changed || current.preamble !== preamble ? { rows: next.map(metaOf), preamble } : current))
  }, [kinds, classify])

  const scheduleResync = useCallback(() => {
    window.clearTimeout(resyncTimer.current)
    resyncTimer.current = window.setTimeout(() => resync(getText()), 0)
  }, [resync, getText])

  /** Applies a section operation's result to the whole document. */
  const applyText = useCallback((next: string | null, undoable = false) => {
    if (next === null || next === getText()) return false
    resync(next, undoable)
    parent.current.onDocChanged()
    return true
  }, [getText, resync])

  /** A section dragged by its grip and dropped before or after another (row indexes, the text before the first section included). */
  const reorderSections = (from: number, target: number, after: boolean) => {
    const offset = meta.rows[0]?.title === null ? 1 : 0
    const source = from - offset
    // Dropped before the text that precedes every section: it becomes the first section.
    const at = Math.max(0, target - offset)
    const place = after && target >= offset ? at + 1 : at
    const to = source < place ? place - 1 : place
    if (source < 0) return
    applyText(moveSectionText(getText(), source, to, classify))
  }

  const onCellChanges = useCallback((id: number, kind: CellKind, changes: ChangeSet, text: string) => {
    if (applying.current) {
      parent.current.onDocChanged()
      return
    }
    const row = rows.current.find((candidate) => candidate.id === id)
    if (!row) return
    row.cells[kind] = applyChange(row.cells[kind], text, changes)
    row.text = sectionText(row.cells[kind])
    // The section's other layers were projected from the old text: project them again.
    for (const otherKind of kinds) {
      if (otherKind === kind) continue
      const fresh = project(row.text, otherKind, classify)
      if (fresh.text !== row.cells[otherKind].text) handles.current.get(cellKey(id, otherKind))?.sync(fresh.text)
      row.cells[otherKind] = fresh
    }
    if (kind === 'output' && row.title !== null && !row.named) {
      const heading = sectionTitle(row.text, classify)
      if (heading !== null && heading !== row.title) {
        row.title = heading
        row.key = titleKey(heading)
        setMeta((current) => ({ ...current, rows: current.rows.map((item) => (item.id === id ? { ...item, title: heading, key: titleKey(heading) } : item)) }))
      }
    }
    parent.current.onDocChanged()
  }, [kinds, classify])

  const register = useCallback((key: string, handle: MarkdownEditorHandle | null) => {
    if (!handle) {
      handles.current.delete(key)
      return
    }
    handles.current.set(key, handle)
    const work = pending.current.get(key)
    if (work) {
      pending.current.delete(key)
      // The editor view is made just after its handle is attached.
      window.setTimeout(() => work(handle), 0)
    }
  }, [])

  /** The rows on screen with their primary layer open, in order. */
  const shownRows = useCallback(() => rows.current.filter((row) => handles.current.has(cellKey(row.id, primary))), [primary])

  /** Moves the cursor to the same layer of the next or previous section. */
  const moveBetweenRows = useCallback((id: number, kind: CellKind, direction: 1 | -1) => {
    const list = shownRows()
    const index = list.findIndex((row) => row.id === id)
    const target = list[index + direction]
    if (!target) return false
    const handle = handles.current.get(cellKey(target.id, kind))
    if (!handle) return false
    handle.focusAt(direction === 1 ? 0 : handle.getText().length)
    return true
  }, [shownRows])

  /**
   * The document as it would be after starting a named section at the cursor: at the
   * line the cursor (or the selection) starts on, or the next line with text if that
   * one is blank. With a selection, the new section holds just the selected lines, and
   * the text after them continues as “Name (continued)”. Null when the cursor is not
   * in the section's text, or the section would be left with only its heading.
   */
  const planSplit = useCallback((id: number): string | null => {
    const index = rows.current.findIndex((row) => row.id === id)
    const row = rows.current[index]
    const handle = handles.current.get(cellKey(id, 'output'))
    if (!row || !handle) return null
    const text = handle.getText()
    const cursor = handle.cursor()
    const selected = handle.getSelection()
    // The cursor is at one end of the selection: the end if it was made downwards.
    const start = selected && text.slice(cursor - selected.length, cursor) === selected ? cursor - selected.length : cursor
    const end = start + selected.length
    const lines = text.split('\n')
    const lineAt = (offset: number) => text.slice(0, offset).split('\n').length - 1
    const nextText = (line: number) => {
      while (line < lines.length && lines[line].trim() === '') line += 1
      return line
    }
    const first = nextText(lineAt(start))
    if (first >= lines.length) return null
    const shown = shownLineNumbers(row.cells.output)
    let rest: { line: number; name: string } | undefined
    if (selected) {
      // A selection that ends at the start of a line does not take that line.
      const last = lineAt(end) - (end > start && text[end - 1] === '\n' ? 1 : 0)
      const after = nextText(Math.max(last, first) + 1)
      if (after < lines.length) rest = { line: shown[after], name: continuedName(row.title) }
    }
    return splitSection(getText(), index, shown[first], NEW_SECTION_NAME, rest, classify)
  }, [getText, classify])

  /**
   * Shows the name box. Deferred, so a menu that is closing has given focus back
   * first: the box would otherwise lose focus at once, which cancels the rename.
   */
  const startRename = useCallback((id: number) => {
    window.setTimeout(() => setRenaming(id), 0)
  }, [])

  /** Starts a named section at the cursor (see `planSplit`), then asks for its name. */
  const splitAtCursor = useCallback((id: number) => {
    if (readOnly) return false
    const index = rows.current.findIndex((row) => row.id === id)
    if (!applyText(planSplit(id))) return false
    const created = rows.current[index + 1]
    if (created) startRename(created.id)
    return true
  }, [applyText, planSplit, startRename, readOnly])

  const keysFor = useCallback((id: number, kind: CellKind): KeyBinding[] => {
    const atEdge = (view: EditorView, forward: boolean) => {
      const range = view.state.selection.main
      return range.empty && view.moveVertically(range, forward).head === range.head
    }
    // Ctrl+Alt+N goes round the layers shown for the section.
    const cycle = [primary, ...(secondaries.length ? secondaries : kinds.filter((candidate) => candidate !== primary).slice(0, 1))]
    const next = cycle[(cycle.indexOf(kind) + 1) % cycle.length] ?? primary
    return [
      { key: 'ArrowDown', run: (view) => atEdge(view, true) && moveBetweenRows(id, kind, 1) },
      { key: 'ArrowUp', run: (view) => atEdge(view, false) && moveBetweenRows(id, kind, -1) },
      {
        key: 'Mod-Alt-n',
        run: () => {
          withCell(id, next, (handle) => handle.focusAt(0))
          return true
        },
      },
      { key: 'Mod-Alt-s', run: () => kind === 'output' && splitAtCursor(id) },
    ]
  }, [moveBetweenRows, withCell, splitAtCursor, primary, secondaries, kinds])

  const activeHandle = () => {
    const current = active.current
    const found = current ? handles.current.get(cellKey(current.id, current.kind)) : undefined
    if (found) return found
    const first = shownRows()[0]
    return first ? handles.current.get(cellKey(first.id, primary)) : undefined
  }

  /** The 1-based file line each row starts on. */
  const rowStarts = () => {
    const starts: number[] = []
    let line = 1
    for (const row of rows.current) {
      starts.push(line)
      line += row.text.split('\n').length
    }
    return starts
  }

  /** The layers in the order to look for something in: what the view shows first. */
  const searchOrder = (): CellKind[] => [primary, ...secondaries, ...kinds.filter((kind) => kind !== primary && !secondaries.includes(kind))]

  /** Shows `next` (the whole file) as suggestions in the editors whose text it changes. */
  const proposeFile = (next: string, label: string, additive: boolean): number => {
    const sections = partition(next, classify)
    const before = rows.current
    let { start, endBefore, endAfter } = changedRun(before.map((row) => row.text), sections.map((section) => section.text))
    if (start === endBefore && start === endAfter) return 0
    // New sections with nothing to replace join the row before them (or after, at the top).
    if (start === endBefore) {
      if (start > 0) start -= 1
      else {
        endBefore += 1
        endAfter += 1
      }
    }
    let count = 0
    for (let index = start; index < endBefore; index += 1) {
      const row = before[index]
      const last = index === endBefore - 1
      const target = last ? joinSections(sections.slice(index, endAfter)) : (sections[index] && index < endAfter ? sections[index].text : '')
      for (const kind of kinds) {
        const current = row.cells[kind].text
        const wanted = project(target, kind, classify).text
        if (wanted === current) continue
        count += suggestEdits(current, wanted).length
        withCell(row.id, kind, (handle) => {
          if (!additive) {
            handle.propose(wanted, label)
            return
          }
          let from = 0
          while (from < current.length && from < wanted.length && current[from] === wanted[from]) from += 1
          let end = 0
          while (end < current.length - from && end < wanted.length - from && current[current.length - 1 - end] === wanted[wanted.length - 1 - end]) end += 1
          handle.proposeRange(from, current.length - end, wanted.slice(from, wanted.length - end), label)
        })
      }
    }
    return count
  }

  useImperativeHandle(ref, () => ({
    getText,
    focus: () => activeHandle()?.focus(),
    revealLine: (line) => {
      const starts = rowStarts()
      let index = starts.length - 1
      while (index > 0 && starts[index] > line) index -= 1
      const row = rows.current[index]
      if (!row) return
      const offset = line - starts[index]
      const reveal = (kind: CellKind, at: number) => withCell(row.id, kind, (handle) => handle.revealLine(at + 1))
      for (const kind of searchOrder()) {
        const at = shownLineNumbers(row.cells[kind]).indexOf(offset)
        if (at >= 0) return reveal(kind, at)
      }
      const before = shownLineNumbers(row.cells[primary]).filter((number) => number <= offset).length
      reveal(primary, Math.max(0, before - 1))
    },
    currentWord: () => activeHandle()?.currentWord() ?? null,
    replaceWord: (replacement) => activeHandle()?.replaceWord(replacement) ?? false,
    getSelection: () => activeHandle()?.getSelection() ?? '',
    replaceAll: (text) => {
      applyText(text, true)
    },
    cursorLine: () => {
      const current = active.current
      const handle = current ? handles.current.get(cellKey(current.id, current.kind)) : undefined
      const index = current ? rows.current.findIndex((row) => row.id === current.id) : -1
      if (!current || !handle || index < 0) return 1
      const row = rows.current[index]
      const offset = toSectionOffset(row.cells[current.kind], handle.cursor())
      return rowStarts()[index] + row.text.slice(0, offset).split('\n').length - 1
    },
    propose: (text, label) => proposeFile(text, label, false),
    proposeRange: (from, to, insert, label) => {
      const text = getText()
      return proposeFile(text.slice(0, from) + insert + text.slice(to), label, true)
    },
    pendingSuggestions: () => [...handles.current.values()].reduce((sum, handle) => sum + handle.pendingSuggestions(), 0),
    sync: (text) => resync(text),
    cursor: () => {
      const current = active.current
      const handle = current ? handles.current.get(cellKey(current.id, current.kind)) : undefined
      const index = current ? rows.current.findIndex((row) => row.id === current.id) : -1
      if (!current || !handle || index < 0) return 0
      return joinSections(rows.current.slice(0, index)).length + (index > 0 ? 1 : 0) + toSectionOffset(rows.current[index].cells[current.kind], handle.cursor())
    },
    focusAt: (offset) => {
      let start = 0
      for (const row of rows.current) {
        if (offset <= start + row.text.length) {
          const inside = offset - start
          for (const kind of searchOrder()) {
            const at = fromSectionOffset(row.cells[kind], inside)
            if (at !== null) return withCell(row.id, kind, (handle) => handle.focusAt(at))
          }
          return withCell(row.id, primary, (handle) => handle.focusAt(0))
        }
        start += row.text.length + 1
      }
    },
    hasFocus: () => [...handles.current.values()].some((handle) => handle.hasFocus()),
  }))

  const sideLabel = secondaries.length === 1 ? kindLabel(secondaries[0]).toLowerCase() : 'side panels'
  const changeView = (change: (current: DocumentView) => DocumentView) => parent.current.onViewChange(change)
  const toggleIn = (list: string[], key: string, on: boolean) => (on ? [...list.filter((item) => item !== key), key] : list.filter((item) => item !== key))

  /** The section menu for row `index` of `meta.rows`. */
  const menuFor = (index: number, shown: boolean, sized: boolean): MenuItem[] => {
    const rowMeta = meta.rows[index]
    const titled = rowMeta.title !== null
    const previous = meta.rows[index - 1]
    const nextRow = meta.rows[index + 1]
    const firstTitled = meta.rows[0]?.title === null ? 1 : 0
    const withText = (change: (text: string) => string | null, undoable = false) => () => applyText(change(getText()), undoable)
    // In a document folder every section is a file with a name; a heading is a setting of the file.
    const folder = isFolderText(getText(), classify)
    const asHeading = !rowMeta.named || rowMeta.heading
    const collapsed = view.collapsed.includes(rowMeta.key)
    const items: MenuItem[] = []
    if (titled) {
      items.push(
        { label: 'Rename section', onClick: () => startRename(rowMeta.id) },
        {
          label: 'Show name as a heading',
          checked: asHeading,
          title: folder
            ? 'Exports show the name as a heading. Without one, the name only labels the section here.'
            : 'A heading is part of the text (and of exports). Without one, the name only labels the section here.',
          // Not undoable in the editor: undoing there would drop the heading line and the section with it.
          onClick: withText((text) => setSectionHeading(text, index, !asHeading, classify)),
        },
        'separator',
        { label: 'Move up', disabled: index <= firstTitled, onClick: withText((text) => moveSection(text, index, -1, classify)) },
        { label: 'Move down', disabled: !nextRow, onClick: withText((text) => moveSection(text, index, 1, classify)) },
        {
          label: `Merge into ${previous?.title ? `“${previous.title}”` : 'the text above'}`,
          disabled: !previous || (previous.title === null && !meta.preamble),
          title: asHeading ? 'The heading becomes a subheading' : 'The name is removed',
          onClick: withText((text) => mergeIntoPrevious(text, index, classify)),
        },
      )
    }
    items.push({
      label: nextRow ? `Merge “${nextRow.title}” into this` : 'Merge the next section into this',
      disabled: !nextRow,
      onClick: withText((text) => mergeIntoPrevious(text, index + 1, classify)),
    })
    if (primary === 'output') {
      const inText = active.current?.id === rowMeta.id && active.current.kind === 'output'
      const possible = inText && planSplit(rowMeta.id) !== null
      const selection = inText && (handles.current.get(cellKey(rowMeta.id, 'output'))?.getSelection() ?? '') !== ''
      items.push({
        label: selection ? 'New section from the selection' : 'New section from this paragraph',
        hint: 'Ctrl+Alt+S',
        disabled: !possible,
        title: possible
          ? selection
            ? 'The selected paragraphs become a named section; the text after them continues the current section'
            : 'Starts a named section at the paragraph the cursor is in'
          : inText
            ? 'The section would be left with nothing but its heading: put the cursor in a later paragraph'
            : 'Put the cursor in a paragraph of this section first',
        onClick: () => splitAtCursor(rowMeta.id),
      })
    }
    items.push('separator')
    if (!pageMode) {
      items.push(
        { label: 'Open on its own page', title: 'This section alone, with all its layers', onClick: () => changeView((current) => ({ ...current, page: rowMeta.key })) },
        { label: collapsed ? 'Expand' : 'Collapse', onClick: () => changeView((current) => ({ ...current, collapsed: toggleIn(current.collapsed, rowMeta.key, !collapsed) })) },
        { label: 'Hide from this view', onClick: () => changeView((current) => ({ ...current, hidden: toggleIn(current.hidden, rowMeta.key, true) })) },
      )
    }
    if (secondaryShown && !pageMode) {
      items.push(
        { label: `${shown ? 'Hide' : 'Show'} the ${sideLabel}`, onClick: () => setRowShown(rowMeta.key, !shown) },
        { label: 'Fit height to the text', disabled: !sized, onClick: () => setRowHeight(rowMeta.key, null) },
      )
    }
    if (onManageLayers) items.push({ label: 'Layers…', title: 'Add, rename or delete this document’s layers', onClick: onManageLayers })
    if (titled) {
      items.push('separator', {
        label: 'Delete section…',
        onClick: () => {
          const text = getText()
          const what = model.names.length === 1 ? `its text and its ${model.names[0]}` : 'its text and all its layers'
          if (!window.confirm(`Delete “${rowMeta.title}”, ${what}? An earlier version is kept in History.`)) return
          void window.verdandi.history.snapshot(path, text, `Before deleting “${rowMeta.title}”`).catch(() => {})
          applyText(deleteSection(text, index, classify))
        },
      })
    }
    return items
  }

  const visible = meta.rows.map((rowMeta, index) => inView(rowMeta, index))
  const shownCount = visible.filter(Boolean).length
  const pageIndex = pageMode ? meta.rows.findIndex((rowMeta) => rowMeta.key === view.page) : -1
  // A page whose section is gone (deleted, or renamed in a one-file document) goes back to all the sections.
  const lostPage = pageMode && pageIndex < 0
  useEffect(() => {
    if (lostPage) parent.current.onViewChange((current) => ({ ...current, page: null }))
  }, [lostPage])
  const titledRows = meta.rows.filter((rowMeta) => rowMeta.title !== null || meta.preamble)
  const pagePosition = pageMode ? titledRows.findIndex((rowMeta) => rowMeta.key === view.page) : -1
  const goToPage = (offset: number) => {
    const target = titledRows[pagePosition + offset]
    if (target) changeView((current) => ({ ...current, page: target.key }))
  }
  const left = meta.rows.length - shownCount - (meta.rows[0]?.title === null && !meta.preamble ? 1 : 0)

  const classes = [
    'section-grid', `primary-${primary === 'output' ? 'output' : 'layer'}`, secondaryShown ? '' : 'secondary-off',
    view.layout === 'stacked' ? 'layout-stacked' : '', pageMode ? 'page-mode' : '',
    // A list layer first reads as one outline of the whole document, its sections dragged by their grips.
    layers?.find((layer) => layer.name === primary)?.kind === 'list' ? 'primary-list' : '',
  ].filter(Boolean).join(' ')

  return (
    <div className={classes}>
      {pageMode && pageIndex >= 0 ? (
        <nav className="section-page-nav" aria-label="Section page">
          <button type="button" className="link-button" onClick={() => changeView((current) => ({ ...current, page: null }))}
            title="Back to all the sections">
            <Rows3 size={14} aria-hidden="true" /> All sections
          </button>
          <span className="section-page-count">{pagePosition + 1} of {titledRows.length}</span>
          <button type="button" className="icon-button" disabled={pagePosition <= 0} onClick={() => goToPage(-1)} aria-label="Previous section" title="Previous section">
            <ChevronLeft size={15} aria-hidden="true" />
          </button>
          <button type="button" className="icon-button" disabled={pagePosition >= titledRows.length - 1} onClick={() => goToPage(1)} aria-label="Next section" title="Next section">
            <ChevronRight size={15} aria-hidden="true" />
          </button>
        </nav>
      ) : (
        title && <h1 className="section-doc-title">{title}</h1>
      )}
      {meta.rows.map((rowMeta, index) => {
        if (!visible[index]) return null
        const key = rowMeta.key
        const collapsed = !pageMode && view.collapsed.includes(key)
        const shown = pageMode ? secondaryShown : (overrides[key] ?? secondaryShown) && secondaryShown
        const height = shown && !pageMode ? heights[key] : undefined
        return (
          <SectionRow
            key={rowMeta.id}
            id={rowMeta.id}
            title={rowMeta.title}
            named={rowMeta.named}
            heading={rowMeta.heading}
            primary={primary}
            secondaries={secondaries}
            shown={shown}
            canShow={secondaryShown}
            collapsed={collapsed}
            resizable={!pageMode}
            onCollapse={pageMode ? null : (value) => changeView((current) => ({ ...current, collapsed: toggleIn(current.collapsed, key, value) }))}
            height={height}
            renaming={renaming === rowMeta.id}
            menu={readOnly ? null : () => menuFor(index, shown, height !== undefined)}
            reorder={readOnly || pageMode ? null : { index, draggable: rowMeta.title !== null, onDrop: reorderSections }}
            onRename={(name) => {
              setRenaming(null)
              if (name !== null) applyText(renameSection(getText(), index, name, classify), true)
              withCell(rowMeta.id, primary, (handle) => handle.focus())
            }}
            initialText={(kind) => rowById(rowMeta.id)?.cells[kind]?.text ?? ''}
            onShow={(value) => setRowShown(key, value)}
            onHeight={(value) => setRowHeight(key, value)}
            cell={(kind) => ({
              path,
              imageFolder: layers ? path : undefined,
              gallery,
              sectionName: rowMeta.title ?? 'the text before the first section',
              live,
              focusMode,
              readOnly,
              register,
              keys: keysFor(rowMeta.id, kind),
              onChanges: (changes: ChangeSet, text: string) => onCellChanges(rowMeta.id, kind, changes, text),
              onSave,
              onFocus: () => {
                active.current = { id: rowMeta.id, kind }
                parent.current.onFocus?.()
              },
              onBlur: () => {
                scheduleResync()
                parent.current.onBlur()
              },
              onSelectWord: (word: WordInContext) => parent.current.onSelectWord?.(word),
            })}
          />
        )
      })}
      {!pageMode && left > 0 && (
        <p className="section-grid-left-out">
          {left === 1 ? 'One section is' : `${left} sections are`} not in this view.{' '}
          <button type="button" className="link-button" onClick={() => changeView((current) => ({ ...current, hidden: [], filter: {} }))}>Show all</button>
        </p>
      )}
    </div>
  )
}

interface CellProps {
  path: string
  /** A document folder's path, where its images are; unset for a one-file document. */
  imageFolder?: string
  /** The layers shown as a gallery of images. */
  gallery: readonly CellKind[]
  /** The section's name, for labels. */
  sectionName: string
  live: boolean
  focusMode: boolean
  readOnly: boolean
  register: (key: string, handle: MarkdownEditorHandle | null) => void
  keys: KeyBinding[]
  onChanges: (changes: ChangeSet, text: string) => void
  onSave: () => void
  onFocus: () => void
  onBlur: () => void
  onSelectWord: (word: WordInContext) => void
}

function Cell({ id, kind, initialText, props }: { id: number; kind: CellKind; initialText: () => string; props: CellProps }) {
  // The editor is made once with the text of the moment; later changes reach it through its handle.
  const [initial] = useState(initialText)
  const { register } = props
  const key = cellKey(id, kind)
  const attach = useCallback((handle: MarkdownEditorHandle | null) => register(key, handle), [register, key])
  const editor = (ref: (handle: MarkdownEditorHandle | null) => void, onText?: (text: string) => void) => (
    <MarkdownEditor
      ref={ref}
      variant="cell"
      path={props.path}
      imageFolder={props.imageFolder}
      initialText={initial}
      placeholder={placeholderFor(kind)}
      live={props.live}
      focusMode={props.focusMode}
      readOnly={props.readOnly}
      extraKeys={props.keys}
      onChanges={onText ? (changes, text) => {
        props.onChanges(changes, text)
        onText(text)
      } : props.onChanges}
      onDocChanged={noop}
      onSave={props.onSave}
      onBlur={props.onBlur}
      onFocus={props.onFocus}
      onSelectWord={props.onSelectWord}
    />
  )
  if (props.gallery.includes(kind) && props.imageFolder) {
    return (
      <GalleryCell folder={props.imageFolder} readOnly={props.readOnly} initialText={initial} register={attach} editor={editor}
        label={`${kindLabel(kind)} of ${props.sectionName}`} />
    )
  }
  return editor(attach)
}

const noop = () => {}

/** The section's name, editable in place. */
function NameInput({ initial, onDone }: { initial: string; onDone: (name: string | null) => void }) {
  const [value, setValue] = useState(initial)
  const done = useRef(false)
  const finish = (name: string | null) => {
    if (done.current) return
    done.current = true
    onDone(name)
  }
  return (
    <input
      className="section-name-input"
      autoFocus
      value={value}
      aria-label="Section name"
      onChange={(event) => setValue(event.target.value)}
      onFocus={(event) => event.target.select()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') finish(value.trim() && value.trim() !== initial ? value : null)
        if (event.key === 'Escape') finish(null)
      }}
      onBlur={() => finish(value.trim() && value.trim() !== initial ? value : null)}
    />
  )
}

const SECTION_DRAG = 'application/x-verdandi-section'

function SectionRow({
  id, title, named, heading, primary, secondaries, shown, canShow, collapsed, resizable, onCollapse, height, renaming, menu, reorder, onRename, initialText, onShow, onHeight, cell,
}: {
  id: number
  title: string | null
  named: boolean
  heading: boolean
  primary: CellKind
  /** The other layers the view shows, in order. */
  secondaries: readonly CellKind[]
  /** This section shows its side. */
  shown: boolean
  /** The view shows a side at all. */
  canShow: boolean
  /** Only the name shows. */
  collapsed: boolean
  /** The row's height can be dragged (not on a section's own page, where every layer is as tall as its text). */
  resizable: boolean
  onCollapse: ((collapsed: boolean) => void) | null
  height: number | undefined
  renaming: boolean
  /** The section menu's items, or null for a document that cannot be edited. */
  menu: (() => MenuItem[]) | null
  /** Dragging sections by their grip to reorder them, or null where they can't be. */
  reorder: { index: number; draggable: boolean; onDrop: (from: number, target: number, after: boolean) => void } | null
  onRename: (name: string | null) => void
  initialText: (kind: CellKind) => string
  onShow: (shown: boolean) => void
  onHeight: (height: number | null) => void
  cell: (kind: CellKind) => CellProps
}) {
  const row = useRef<HTMLDivElement>(null)
  const primaryBody = useRef<HTMLDivElement>(null)
  const [, setMenuOpen] = useState(0)
  const [dropSide, setDropSide] = useState<'before' | 'after' | null>(null)
  const sectionName = title ?? 'Before the first section'
  const sideName = secondaries.length === 1 ? kindLabel(secondaries[0]).toLowerCase() : 'side panels'

  // How tall the primary side's text is, for the secondary side when the two are stacked.
  useLayoutEffect(() => {
    const body = primaryBody.current
    const element = row.current
    if (!body || !element) return
    const observer = new ResizeObserver(() => element.style.setProperty('--fit-height', `${body.scrollHeight}px`))
    observer.observe(body.firstElementChild ?? body)
    return () => observer.disconnect()
  }, [collapsed])

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const element = row.current
    if (!element || event.button !== 0) return
    event.preventDefault()
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    const startY = event.clientY
    const startHeight = element.getBoundingClientRect().height
    let latest = startHeight
    element.classList.add('sized', 'resizing')
    const move = (moveEvent: PointerEvent) => {
      latest = Math.max(MIN_ROW_HEIGHT, Math.round(startHeight + moveEvent.clientY - startY))
      element.style.setProperty('--row-height', `${latest}px`)
    }
    const end = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', end)
      handle.removeEventListener('pointercancel', end)
      element.classList.remove('resizing')
      onHeight(latest)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
  }

  const menuButton = menu && (
    <DropdownMenu
      items={menu()}
      trigger={(
        <button type="button" className="icon-button section-menu-button" aria-label={`Section menu for ${sectionName}`} title="Section menu"
          onPointerDown={() => setMenuOpen((count) => count + 1)}>
          <Ellipsis size={15} aria-hidden="true" />
        </button>
      )}
    />
  )

  const grip = reorder?.draggable && (
    <span
      className="section-grip"
      draggable
      role="button"
      aria-label={`Drag ${sectionName} to move it`}
      title="Drag to move this section"
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData(SECTION_DRAG, String(reorder.index))
        if (row.current) event.dataTransfer.setDragImage(row.current, 16, 16)
      }}
    >
      <GripVertical size={14} aria-hidden="true" />
    </span>
  )

  const collapseButton = onCollapse && (
    <button type="button" className="icon-button section-collapse" onClick={() => onCollapse(!collapsed)}
      aria-expanded={!collapsed} aria-label={collapsed ? `Expand ${sectionName}` : `Collapse ${sectionName}`}
      title={collapsed ? 'Expand this section' : 'Collapse this section to its name'}>
      {collapsed ? <ChevronsUpDown size={13} aria-hidden="true" /> : <ChevronsDownUp size={13} aria-hidden="true" />}
    </button>
  )

  // A heading in the text already names the section there; otherwise the name gets a line of its own.
  const nameLine = renaming || collapsed || primary !== 'output' || named
  const style = { '--layer-count': secondaries.length, ...(height ? { '--row-height': `${height}px` } : {}) } as CSSProperties
  const sideShown = shown && !collapsed

  return (
    <div
      ref={row}
      className={[
        'section-row', sideShown ? '' : 'secondary-hidden', height ? 'sized' : '', title === null ? 'section-preamble' : '',
        nameLine ? 'has-name-line' : '', collapsed ? 'collapsed' : '', dropSide ? `drop-${dropSide}` : '',
      ].filter(Boolean).join(' ')}
      onDragOver={reorder ? (event) => {
        if (!event.dataTransfer.types.includes(SECTION_DRAG)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        const box = event.currentTarget.getBoundingClientRect()
        setDropSide(event.clientY > box.top + box.height / 2 ? 'after' : 'before')
      } : undefined}
      onDragLeave={reorder ? (event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropSide(null)
      } : undefined}
      onDrop={reorder ? (event) => {
        const side = dropSide
        setDropSide(null)
        const from = event.dataTransfer.getData(SECTION_DRAG)
        if (!from || side === null) return
        event.preventDefault()
        if (Number(from) !== reorder.index) reorder.onDrop(Number(from), reorder.index, side === 'after')
      } : undefined}
      style={style}
      data-section={sectionName}
    >
      {nameLine && (
        <div className={`section-name-line${named && !heading ? ' named' : ''}`}>
          {renaming && title !== null ? (
            <NameInput initial={title} onDone={onRename} />
          ) : (
            <h2 className="section-name" title={named && !heading ? 'Section name (not a heading in the text)' : 'Section heading'}
              onDoubleClick={collapsed && onCollapse ? () => onCollapse(false) : undefined}>{sectionName}</h2>
          )}
          <span className="section-name-rule" aria-hidden="true" />
          {grip}
          {collapseButton}
          {menuButton}
        </div>
      )}
      {!collapsed && (
        <div className="section-cell section-primary">
          {!nameLine && <div className="section-menu-float">{grip}{collapseButton}{menuButton}</div>}
          <div className="cell-body" ref={primaryBody}>
            <Cell key={primary} id={id} kind={primary} initialText={() => initialText(primary)} props={cell(primary)} />
          </div>
        </div>
      )}
      {sideShown && (
        <div className="section-cell section-secondary">
          <div className="cell-stack">
            {secondaries.map((kind) => (
              <div className="cell-frame" key={kind}>
                <div className="cell-caption">
                  <span>{kindLabel(kind)}</span>
                  {kind === secondaries[0] && (
                    <button type="button" className="icon-button cell-hide" onClick={() => onShow(false)}
                      title={`Hide the ${sideName} for “${sectionName}”`} aria-label={`Hide ${sideName}`}>
                      <EyeOff size={13} aria-hidden="true" />
                    </button>
                  )}
                </div>
                <div className="cell-body">
                  <Cell key={kind} id={id} kind={kind} initialText={() => initialText(kind)} props={cell(kind)} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {!sideShown && canShow && !collapsed && (
        <button type="button" className="icon-button section-show" onClick={() => onShow(true)}
          title={`Show the ${sideName} for “${sectionName}”`} aria-label={`Show ${sideName}`}>
          <PanelRightOpen size={14} aria-hidden="true" />
        </button>
      )}
      {sideShown && resizable && (
        <div
          className="section-resize"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Section height"
          title="Drag to change this section’s height · double-click to fit its text"
          onPointerDown={startResize}
          onDoubleClick={() => {
            row.current?.style.removeProperty('--row-height')
            onHeight(null)
          }}
        />
      )}
    </div>
  )
}
