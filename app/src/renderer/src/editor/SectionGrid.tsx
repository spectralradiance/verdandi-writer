import type { ChangeSet } from '@codemirror/state'
import type { EditorView, KeyBinding } from '@codemirror/view'
import { ChevronDown, ChevronLeft, ChevronRight, ChevronsDownUp, ChevronsUpDown, Columns3, Ellipsis, GripVertical, PanelRightClose, PanelRightOpen, Rows3 } from 'lucide-react'
import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type Ref, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { moveSectionText } from '../../../shared/document'
import { suggestEdits } from '../../../shared/diff'
import { type Layer, layerLabel } from '../../../shared/layers'
import type { LayerNames } from '../../../shared/notes'
import { type DocumentView, foldColumns, matchesFilter, showLayer, sideShowing, type ViewColumn } from '../../../shared/views'
import { DropdownMenu, type MenuItem } from '../menu'
import { GalleryCell } from './GalleryCell'
import { MarkdownEditor, type MarkdownEditorHandle, type WordInContext } from './MarkdownEditor'
import {
  applyChange, type CellKind, changedRun, continuedName, deleteSection, fromSectionOffset, isFolderText, joinSections, mergeIntoPrevious, moveSection, partition,
  project, type Projection, renameSection, sectionText, sectionTitle, setSectionHeading, shownLineNumbers, showsPreamble,
  splitFromLayer, splitSection, toSectionOffset,
} from './sectionModel'

/**
 * The document as rows, one per section. Each row starts with its primary layer
 * (left, or on top when narrow or stacked), and is as tall as that layer's text.
 * One other layer sits beside it (or below), in a panel that stays in view under
 * the bar while a long row scrolls past, and scrolls itself when it holds more
 * than fits. Any layer can be primary: the text, the
 * notes, an outline. Other layers can sit under it in the first column, and up to
 * two columns sit beside it, each showing its layers one at a time (tabs) or all
 * at once (stacked); the view arranges them (see shared/views.ts). A bar stays over
 * the rows as they scroll: on the left the section being read (a menu to jump to
 * another), then each column's tabs. Dragging between the bar's columns sets their
 * widths. A window too narrow for every column folds the later ones into tabs.
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
  /** Opens the screen that arranges the view's columns. */
  onArrange?: () => void
  /** Opens a section's fields (a document folder's section, by its id) to edit them. */
  onEditFields?: (key: string, title: string) => void
}

const NEW_SECTION_NAME = 'New section'
/** Narrower than this per column, the later columns fold into tabs. */
const MIN_COLUMN_WIDTH = 340
/** The narrowest a column can be dragged in the bar. */
const MIN_DRAG_WIDTH = 160
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

export function SectionGrid({
  ref, path, initialText, title, layers, view, onViewChange, fields, live, focusMode, readOnly = false,
  onDocChanged, onSave, onBlur, onFocus, onSelectWord, onManageLayers, onEditFields, onArrange,
}: SectionGridProps) {
  // The layers are fixed for the grid's life: changing them reloads the document.
  const [model] = useState(() => {
    const names = layers ? layers.map((layer) => layer.name) : ['notes']
    return {
      kinds: ['output', ...names] as CellKind[], classify: (layers ? names : null) as LayerNames, names,
      gallery: layers ? layers.filter((layer) => layer.kind === 'gallery').map((layer) => layer.name) : [],
      /** Layers whose blocks stay with a section split from its text (a one-file document's notes are anchored). */
      stay: layers ? layers.filter((layer) => !layer.anchored).map((layer) => layer.name) : [],
    }
  })
  const { kinds, classify, gallery } = model
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
  const pageMode = view.page !== null
  const grid = useRef<HTMLDivElement>(null)
  const bar = useRef<HTMLDivElement>(null)
  /** The grid's width, for folding columns that wouldn't fit. */
  const [gridWidth, setGridWidth] = useState(0)
  /** The layer showing in a column made of folded ones (they each keep their own in the view). */
  const [foldedActive, setFoldedActive] = useState<CellKind | null>(null)
  const { sideKinds, under, placed, folded, columns, showing, secondaries } = useMemo(() => {
    const others = kinds.filter((kind) => kind !== primary)
    // A section's own page has every layer, one under another, in the first column.
    const below = pageMode ? [] : view.under.filter((kind) => others.includes(kind))
    const inColumns: ViewColumn[] = view.columns
      .map((column) => ({ ...column, layers: column.layers.filter((kind) => others.includes(kind) && !below.includes(kind)) }))
      .filter((column) => column.layers.length > 0)
    const fits = gridWidth > 0 ? Math.max(1, Math.floor(gridWidth / MIN_COLUMN_WIDTH) - 1) : inColumns.length
    const fold = !pageMode && view.layout === 'side' && inColumns.length > fits
    const shown: ViewColumn[] = pageMode
      ? (others.length ? [{ layers: others, mode: 'stack', active: null, width: 1 }] : [])
      : fold
        ? foldColumns(inColumns, fits).map((column, index, all) => (
          index === all.length - 1 && foldedActive && column.layers.includes(foldedActive) ? { ...column, active: foldedActive } : column
        ))
        : inColumns
    const on = shown.length > 0 && (pageMode || !view.sideHidden)
    /** What each column shows in every row, by column. */
    const each = on ? sideShowing(shown) : []
    return { sideKinds: others, under: below, placed: inColumns, folded: fold, columns: shown, showing: each, secondaries: each.flat() }
  }, [kinds, primary, pageMode, view.under, view.columns, view.layout, view.sideHidden, gridWidth, foldedActive])
  const sideOn = showing.length > 0
  const secondaryShown = secondaries.length > 0
  const rowColumns = `minmax(0, ${view.primaryWidth}fr) ${columns.map((column) => `minmax(0, ${column.width}fr)`).join(' ')}`
  /** The key of the section at the top of the scrolled rows, for the bar. */
  const [reading, setReading] = useState<string | null>(null)


  const parent = useRef({ onDocChanged, onBlur, onFocus, onSelectWord, onViewChange })
  useLayoutEffect(() => {
    parent.current = { onDocChanged, onBlur, onFocus, onSelectWord, onViewChange }
  })

  useEffect(() => () => window.clearTimeout(resyncTimer.current), [])

  const getText = useCallback(() => joinSections(rows.current), [])
  const rowById = (id: number) => rows.current.find((row) => row.id === id)

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
    if (index === 0 && row.title === null) setMeta((current) => (current.preamble ? current : { ...current, preamble: true }))
    parent.current.onViewChange((current) => {
      let next = current
      if (kind !== primary) {
        next = showLayer(next, kind)
        setFoldedActive(kind)
      }
      if (next.collapsed.includes(row.key)) next = { ...next, collapsed: next.collapsed.filter((key) => key !== row.key) }
      if (next.page !== null && next.page !== row.key) next = { ...next, page: row.key }
      if (next.hidden.includes(row.key)) next = { ...next, hidden: next.hidden.filter((key) => key !== row.key) }
      if (fields && row.key in fields && !matchesFilter(fields[row.key], next.filter)) next = { ...next, filter: {} }
      return next
    })
  }, [primary, fields])

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
  const planSplit = useCallback((id: number, kind: CellKind = 'output'): string | null => {
    const index = rows.current.findIndex((row) => row.id === id)
    const row = rows.current[index]
    const handle = handles.current.get(cellKey(id, kind))
    if (!row || !handle || model.gallery.includes(kind)) return null
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
    const shown = shownLineNumbers(row.cells[kind])
    // A selection that ends at the start of a line does not take that line.
    const last = selected ? Math.max(first, lineAt(end) - (end > start && text[end - 1] === '\n' ? 1 : 0)) : lines.length - 1
    if (kind !== 'output') {
      // From a layer: those lines become a section of their own, after this one.
      return splitFromLayer(getText(), index, kind, shown[first], shown[last] + 1, NEW_SECTION_NAME, classify)
    }
    let rest: { line: number; name: string } | undefined
    if (selected) {
      const after = nextText(last + 1)
      if (after < lines.length) rest = { line: shown[after], name: continuedName(row.title) }
    }
    return splitSection(getText(), index, shown[first], NEW_SECTION_NAME, rest, classify, model.stay)
  }, [getText, classify, model])

  /**
   * Shows the name box. Deferred, so a menu that is closing has given focus back
   * first: the box would otherwise lose focus at once, which cancels the rename.
   */
  const startRename = useCallback((id: number) => {
    window.setTimeout(() => setRenaming(id), 0)
  }, [])

  /** Starts a named section at the cursor (see `planSplit`), then asks for its name. */
  const splitAtCursor = useCallback((id: number, kind: CellKind = 'output') => {
    if (readOnly) return false
    const index = rows.current.findIndex((row) => row.id === id)
    if (!applyText(planSplit(id, kind))) return false
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
    // Galleries are skipped: they have no text to put the cursor in.
    const cycle = [primary, ...under, ...(secondaries.length ? secondaries : sideKinds.filter((candidate) => !under.includes(candidate)).slice(0, 1))]
      .filter((candidate) => candidate === kind || !gallery.includes(candidate))
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
      { key: 'Mod-Alt-s', run: () => splitAtCursor(id, kind) },
    ]
  }, [moveBetweenRows, withCell, splitAtCursor, primary, under, secondaries, sideKinds, gallery])

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
  const searchOrder = (): CellKind[] => [primary, ...under, ...secondaries, ...sideKinds.filter((kind) => !under.includes(kind) && !secondaries.includes(kind))]

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

  const changeView = (change: (current: DocumentView) => DocumentView) => parent.current.onViewChange(change)
  const toggleIn = (list: string[], key: string, on: boolean) => (on ? [...list.filter((item) => item !== key), key] : list.filter((item) => item !== key))

  /** The section menu for row `index` of `meta.rows`. */
  const menuFor = (index: number): MenuItem[] => {
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
    {
      // The split starts from the layer the cursor is in: the text, or another layer.
      const cell = active.current?.id === rowMeta.id && !gallery.includes(active.current.kind) ? active.current.kind : null
      const kind = cell ?? primary
      const possible = cell !== null && planSplit(rowMeta.id, cell) !== null
      const selection = cell !== null && (handles.current.get(cellKey(rowMeta.id, cell))?.getSelection() ?? '') !== ''
      const fromText = kind === 'output'
      const layerName = kindLabel(kind).toLowerCase()
      items.push({
        label: selection ? 'New section from the selection' : fromText ? 'New section from this paragraph' : `New section from here in the ${layerName}`,
        hint: 'Ctrl+Alt+S',
        disabled: !possible,
        title: possible
          ? fromText
            ? selection
              ? 'The selected paragraphs become a named section; the text after them continues the current section'
              : 'Starts a named section at the paragraph the cursor is in'
            : selection
              ? `The selected lines leave this section’s ${layerName} and become a new section after it, with blank text`
              : `The ${layerName} from the cursor down becomes a new section after this one, with blank text`
          : cell === null
            ? 'Put the cursor in this section’s text or one of its layers first'
            : fromText
              ? 'The section would be left with nothing but its heading: put the cursor in a later paragraph'
              : `Put the cursor on a line of the ${layerName}`,
        onClick: () => splitAtCursor(rowMeta.id, kind),
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
    if (onEditFields && titled) {
      const saved = fields !== undefined && rowMeta.key in fields
      items.push({
        label: 'Fields…',
        disabled: !saved,
        title: saved ? 'Status, tags and other fields, kept in the main file’s frontmatter' : 'The section isn’t saved yet: it can have fields once it saves, in a moment',
        onClick: () => onEditFields(rowMeta.key, rowMeta.title ?? ''),
      })
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

  // Which section is at the top, under the bar, as the rows scroll (or change).
  useEffect(() => {
    const element = grid.current
    if (!element || pageMode) return
    let frame = 0
    const update = () => {
      frame = 0
      element.style.setProperty('--bar-height', `${bar.current?.offsetHeight ?? 0}px`)
      element.style.setProperty('--view-height', `${element.clientHeight}px`)
      setGridWidth(element.clientWidth)
      const line = (bar.current?.getBoundingClientRect().bottom ?? element.getBoundingClientRect().top) + 4
      let found: string | null = null
      for (const row of element.querySelectorAll<HTMLElement>(':scope > .section-row')) {
        if (row.getBoundingClientRect().top > line) break
        found = row.dataset.key ?? null
      }
      setReading(found)
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    update()
    element.addEventListener('scroll', schedule, { passive: true })
    // Resize callbacks already come once a frame: measure at once (a frame may never come while the window is hidden).
    const observer = new ResizeObserver(() => update())
    observer.observe(element)
    return () => {
      element.removeEventListener('scroll', schedule)
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [meta.rows, pageMode, view])

  /** Scrolls a section's row up to just under the bar. */
  const scrollToSection = (key: string) => {
    const element = grid.current
    const row = element?.querySelector<HTMLElement>(`:scope > .section-row[data-key="${CSS.escape(key)}"]`)
    if (!element || !row) return
    const offset = row.getBoundingClientRect().top - element.getBoundingClientRect().top - (bar.current?.offsetHeight ?? 0)
    element.scrollTo({ top: element.scrollTop + offset })
  }
  const readingRow = meta.rows.find((rowMeta) => rowMeta.key === reading)
  const readingTitle = readingRow ? readingRow.title ?? 'Before the first section' : title
  const jumpItems: MenuItem[] = meta.rows.flatMap((rowMeta, index): MenuItem[] => (
    visible[index] ? [{ label: rowMeta.title ?? 'Before the first section', checked: rowMeta.key === reading, onClick: () => scrollToSection(rowMeta.key) }] : []
  ))
  const chooseTab = (kind: CellKind) => {
    setFoldedActive(kind)
    changeView((current) => showLayer(current, kind))
  }
  /**
   * Arrow keys, Home and End move between a column's tabs, choosing each as they go
   * (one tab stop per column; Tab moves on to the next column).
   */
  const tabKeys = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    const at = tabs.indexOf(document.activeElement as HTMLButtonElement)
    if (at < 0) return
    const target = event.key === 'ArrowRight' ? (at + 1) % tabs.length
      : event.key === 'ArrowLeft' ? (at - 1 + tabs.length) % tabs.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1
    if (target < 0) return
    event.preventDefault()
    tabs[target].focus()
    tabs[target].click()
  }
  const hideSide = () => changeView((current) => ({ ...current, sideHidden: true }))

  /**
   * Dragging the line between two of the bar's columns: they trade width, and the
   * view keeps every column's share against the first one's.
   */
  const startWidthDrag = (index: number) => (event: ReactPointerEvent<HTMLDivElement>) => {
    const element = grid.current
    const strip = bar.current
    if (!element || !strip || event.button !== 0) return
    event.preventDefault()
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    const start = event.clientX
    const widths = [...strip.children].filter((child) => child.classList.contains('section-bar-column')).map((child) => child.getBoundingClientRect().width)
    let latest = widths
    const template = (list: number[]) => list.map((width) => `minmax(0, ${(width / list[0]).toFixed(3)}fr)`).join(' ')
    const move = (moveEvent: PointerEvent) => {
      const shift = Math.max(MIN_DRAG_WIDTH - widths[index - 1], Math.min(widths[index] - MIN_DRAG_WIDTH, moveEvent.clientX - start))
      latest = widths.map((width, at) => (at === index - 1 ? width + shift : at === index ? width - shift : width))
      element.style.setProperty('--row-columns', template(latest))
    }
    const end = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', end)
      handle.removeEventListener('pointercancel', end)
      const shares = latest.map((width) => width / latest[0])
      changeView((current) => (current.columns.length === shares.length - 1
        ? { ...current, primaryWidth: 1, columns: current.columns.map((column, at) => ({ ...column, width: Math.round(shares[at + 1] * 100) / 100 })) }
        : current))
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
  }
  /** Columns can be dragged wider in the bar when they sit side by side as the view has them. */
  const draggable = !folded && view.layout === 'side' && gridWidth > 720 && columns.length > 0 && sideOn
  /** With the side put away, the bar offers every layer that could show beside the text. */
  const offered = placed.length ? placed.flatMap((column) => column.layers) : sideKinds.filter((kind) => !under.includes(kind))

  const classes = [
    'section-grid', `primary-${primary === 'output' ? 'output' : 'layer'}`, secondaryShown ? '' : 'secondary-off',
    view.layout === 'stacked' ? 'layout-stacked' : '', pageMode ? 'page-mode' : '',
    // A list layer first reads as one outline of the whole document, its sections dragged by their grips.
    layers?.find((layer) => layer.name === primary)?.kind === 'list' ? 'primary-list' : '',
  ].filter(Boolean).join(' ')

  return (
    <div className={classes} ref={grid} style={{ '--row-columns': rowColumns } as CSSProperties}>
      {!pageMode && (
        <div className="section-bar" ref={bar}>
          <div className="section-bar-reading section-bar-column">
            {jumpItems.length > 0 ? (
              <DropdownMenu items={jumpItems} trigger={(
                <button type="button" className="section-bar-title" title="The section you are reading · choose one to go to it" aria-label={`Reading ${readingTitle}. Go to another section`}>
                  <span>{readingTitle}</span>
                  <ChevronDown size={13} aria-hidden="true" />
                </button>
              )} />
            ) : (
              <span className="section-bar-title">{readingTitle}</span>
            )}
          </div>
          {sideOn ? columns.map((column, index) => (
            <div key={index} className="section-bar-column" style={{ '--column': index + 2 } as CSSProperties}>
              {draggable && (
                <div className="section-bar-divider" role="separator" aria-orientation="vertical" aria-label="Column width"
                  title="Drag to change the columns’ widths" onPointerDown={startWidthDrag(index + 1)} />
              )}
              {column.mode === 'tabs' ? (
                <div className="section-bar-tabs" role="tablist" aria-label={`Column ${index + 2}`} onKeyDown={tabKeys}>
                  {column.layers.map((kind) => (
                    <button key={kind} type="button" role="tab" className="section-tab" aria-selected={showing[index]?.includes(kind) ?? false}
                      tabIndex={showing[index]?.includes(kind) ? 0 : -1}
                      title={`Show each section’s ${kindLabel(kind).toLowerCase()} in this column`} onClick={() => chooseTab(kind)}>
                      {kindLabel(kind)}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="section-bar-tabs section-bar-stack" title="These layers show one under another in this column">
                  {column.layers.map((kind) => <span key={kind} className="section-tab">{kindLabel(kind)}</span>)}
                </div>
              )}
              {index === columns.length - 1 && (
                <div className="section-bar-actions">
                  {onArrange && (
                    <button type="button" className="icon-button" onClick={onArrange} aria-label="Arrange view" title="Arrange the columns: which layers, tabs or stacked, how wide">
                      <Columns3 size={14} aria-hidden="true" />
                    </button>
                  )}
                  <button type="button" className="icon-button" onClick={hideSide} aria-label="Hide the side columns" title="Hide the side columns: the text takes the full width">
                    <PanelRightClose size={14} aria-hidden="true" />
                  </button>
                </div>
              )}
            </div>
          )) : offered.length > 0 && (
            <div className="section-bar-column" style={{ '--column': 2 } as CSSProperties}>
              <div className="section-bar-tabs" role="tablist" aria-label="Show a layer beside each section" onKeyDown={tabKeys}>
                {offered.map((kind) => (
                  <button key={kind} type="button" role="tab" className="section-tab" aria-selected={false} tabIndex={kind === offered[0] ? 0 : -1}
                    title={`Show each section’s ${kindLabel(kind).toLowerCase()} beside it`} onClick={() => chooseTab(kind)}>
                    {kindLabel(kind)}
                  </button>
                ))}
              </div>
              <div className="section-bar-actions">
                {onArrange && (
                  <button type="button" className="icon-button" onClick={onArrange} aria-label="Arrange view" title="Arrange the columns: which layers, tabs or stacked, how wide">
                    <Columns3 size={14} aria-hidden="true" />
                  </button>
                )}
                {placed.length > 0 && (
                  <button type="button" className="icon-button" onClick={() => changeView((current) => ({ ...current, sideHidden: false }))}
                    aria-label="Show the side columns" title="Show the side columns as they were">
                    <PanelRightOpen size={14} aria-hidden="true" />
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}
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
        return (
          <SectionRow
            key={rowMeta.id}
            id={rowMeta.id}
            sectionKey={key}
            title={rowMeta.title}
            named={rowMeta.named}
            heading={rowMeta.heading}
            primary={primary}
            under={under}
            side={showing}
            collapsed={collapsed}
            onCollapse={pageMode ? null : (value) => changeView((current) => ({ ...current, collapsed: toggleIn(current.collapsed, key, value) }))}
            renaming={renaming === rowMeta.id}
            menu={readOnly ? null : () => menuFor(index)}
            reorder={readOnly || pageMode ? null : { index, draggable: rowMeta.title !== null, onDrop: reorderSections }}
            onRename={(name) => {
              setRenaming(null)
              if (name !== null) applyText(renameSection(getText(), index, name, classify), true)
              withCell(rowMeta.id, primary, (handle) => handle.focus())
            }}
            initialText={(kind) => rowById(rowMeta.id)?.cells[kind]?.text ?? ''}
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
  id, sectionKey, title, named, heading, primary, under, side, collapsed, onCollapse, renaming, menu, reorder, onRename, initialText, cell,
}: {
  id: number
  /** The section's key in the view, for finding its row. */
  sectionKey: string
  title: string | null
  named: boolean
  heading: boolean
  primary: CellKind
  /** Layers shown under the primary one, each with its caption. */
  under: readonly CellKind[]
  /** What each column beside the first shows, by column; empty with the side hidden. */
  side: readonly (readonly CellKind[])[]
  /** Only the name shows. */
  collapsed: boolean
  onCollapse: ((collapsed: boolean) => void) | null
  renaming: boolean
  /** The section menu's items, or null for a document that cannot be edited. */
  menu: (() => MenuItem[]) | null
  /** Dragging sections by their grip to reorder them, or null where they can't be. */
  reorder: { index: number; draggable: boolean; onDrop: (from: number, target: number, after: boolean) => void } | null
  onRename: (name: string | null) => void
  initialText: (kind: CellKind) => string
  cell: (kind: CellKind) => CellProps
}) {
  const row = useRef<HTMLDivElement>(null)
  const primaryBody = useRef<HTMLDivElement>(null)
  const [, setMenuOpen] = useState(0)
  const [dropSide, setDropSide] = useState<'before' | 'after' | null>(null)
  const sectionName = title ?? 'Before the first section'

  // How tall the primary side's text is, for the secondary side when the two are stacked.
  useLayoutEffect(() => {
    const body = primaryBody.current
    const element = row.current
    if (!body || !element) return
    const observer = new ResizeObserver(() => element.style.setProperty('--fit-height', `${body.scrollHeight}px`))
    observer.observe(body.firstElementChild ?? body)
    return () => observer.disconnect()
  }, [collapsed])

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
  const style = { '--layer-count': Math.max(1, ...side.map((kinds) => kinds.length)) } as CSSProperties
  const sideShown = side.length > 0 && !collapsed
  const frame = (kind: CellKind, caption: boolean) => (
    <div className="cell-frame" key={kind}>
      {caption && (
        <div className="cell-caption">
          <span>{kindLabel(kind)}</span>
        </div>
      )}
      <div className="cell-body">
        <Cell key={kind} id={id} kind={kind} initialText={() => initialText(kind)} props={cell(kind)} />
      </div>
    </div>
  )

  return (
    <div
      ref={row}
      className={[
        'section-row', sideShown ? '' : 'secondary-hidden', title === null ? 'section-preamble' : '',
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
      data-key={sectionKey}
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
          {under.length > 0 && <div className="cell-under">{under.map((kind) => frame(kind, true))}</div>}
        </div>
      )}
      {sideShown && side.map((kinds, index) => (
        <div key={index} className="section-cell section-secondary" style={{ '--column': index + 2 } as CSSProperties}>
          <div className="cell-stack">
            {/* A column of one layer needs no caption: the bar's tab names it. */}
            <div className="cell-sticky">{kinds.map((kind) => frame(kind, kinds.length > 1))}</div>
          </div>
        </div>
      ))}
    </div>
  )
}
