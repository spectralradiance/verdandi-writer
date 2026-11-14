import type { ChangeSet } from '@codemirror/state'
import type { EditorView, KeyBinding } from '@codemirror/view'
import { Ellipsis, EyeOff, PanelRightOpen } from 'lucide-react'
import { type CSSProperties, type PointerEvent as ReactPointerEvent, type Ref, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'

import { suggestEdits } from '../../../shared/diff'
import { DropdownMenu, type MenuItem } from '../menu'
import { readPref, writePref } from '../prefs'
import { MarkdownEditor, type MarkdownEditorHandle, type WordInContext } from './MarkdownEditor'
import {
  applyChange, type CellKind, changedRun, deleteSection, fromSectionOffset, joinSections, mergeIntoPrevious, moveSection, partition,
  project, type Projection, renameSection, sectionText, sectionTitle, setSectionHeading, shownLineNumbers, showsPreamble,
  splitSection, toSectionOffset,
} from './sectionModel'

/**
 * The document as rows, one per section. Each row has a primary side (left, or on
 * top when narrow), as tall as its text unless the writer drags the row taller or
 * shorter, and a secondary side (right, or below) that fits in beside it and
 * scrolls. The text view puts the text first and the notes second; the notes
 * view the other way round. The secondary side can be hidden per section or for
 * the whole document.
 *
 * A section starts at a heading, or at a `<!-- section: Name -->` marker for one
 * that has a name but no heading. Each row has a menu to rename, move, merge or
 * delete its section, and to switch its name between a heading and a name only.
 *
 * Every side is its own small editor over a projection of its section (see
 * sectionModel), and the file is the sections joined back together.
 */

interface Row {
  id: number
  /** The section text: the file's lines for this section, joined with \n. */
  text: string
  title: string | null
  named: boolean
  output: Projection
  notes: Projection
}

interface RowMeta {
  id: number
  title: string | null
  named: boolean
}

export interface SectionGridProps {
  ref?: Ref<MarkdownEditorHandle>
  path: string
  initialText: string
  /** The document's title (its file name), shown above the first section. */
  title: string
  /** Which side comes first: the text or the notes. */
  primary: CellKind
  /** Show the secondary side of every section; each section can override it. */
  secondaryShown: boolean
  live: boolean
  focusMode: boolean
  onDocChanged: () => void
  onSave: () => void
  onBlur: () => void
  onFocus?: () => void
  onSelectWord?: (word: WordInContext) => void
}

const MIN_ROW_HEIGHT = 56
const NEW_SECTION_NAME = 'New section'
const other = (kind: CellKind): CellKind => (kind === 'output' ? 'notes' : 'output')
const cellKey = (id: number, kind: CellKind) => `${id}:${kind}`
/** Per-section settings are remembered by name, so they survive reopening the file. */
const rowKey = (title: string | null) => title ?? '\u0000before-first-heading'
const metaOf = ({ id, title, named }: Row): RowMeta => ({ id, title, named })

let nextRowId = 1

function makeRow(section: { text: string; title: string | null; named: boolean }, id = nextRowId++): Row {
  return { id, text: section.text, title: section.title, named: section.named, output: project(section.text, 'output'), notes: project(section.text, 'notes') }
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
  ref, path, initialText, title, primary, secondaryShown, live, focusMode, onDocChanged, onSave, onBlur, onFocus, onSelectWord,
}: SectionGridProps) {
  // Built once; the model and the rendered rows both start from it.
  const [initial] = useState(() => {
    const sections = partition(initialText)
    return { rows: sections.map((section) => makeRow(section)), preamble: showsPreamble(sections) }
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

  const heightsKey = `sectionHeights:${path}`
  const visibilityKey = `sectionSecondary:${path}`
  const [heights, setHeights] = useState<Record<string, number>>(() => readRecord<number>(heightsKey))
  const [overrides, setOverrides] = useState<Record<string, boolean>>(() => readRecord<boolean>(visibilityKey))

  const parent = useRef({ onDocChanged, onBlur, onFocus, onSelectWord })
  useLayoutEffect(() => {
    parent.current = { onDocChanged, onBlur, onFocus, onSelectWord }
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

  const setRowShown = useCallback((rowTitle: string | null, shown: boolean) => {
    setOverrides((current) => {
      const next = { ...current, [rowKey(rowTitle)]: shown }
      writeRecord(visibilityKey, next)
      return next
    })
  }, [visibilityKey])

  const setRowHeight = useCallback((rowTitle: string | null, value: number | null) => {
    setHeights((current) => {
      const next = { ...current }
      if (value === null) delete next[rowKey(rowTitle)]
      else next[rowKey(rowTitle)] = value
      writeRecord(heightsKey, next)
      return next
    })
  }, [heightsKey])

  /** Runs `work` on a row's editor, first showing that side (or the hidden preamble row) if needed. */
  const withCell = useCallback((id: number, kind: CellKind, work: (handle: MarkdownEditorHandle) => void) => {
    const handle = handles.current.get(cellKey(id, kind))
    if (handle) {
      work(handle)
      return
    }
    pending.current.set(cellKey(id, kind), work)
    const row = rows.current.find((candidate) => candidate.id === id)
    if (!row) return
    if (kind !== primary) setRowShown(row.title, true)
    if (row === rows.current[0] && row.title === null) setMeta((current) => (current.preamble ? current : { ...current, preamble: true }))
  }, [primary, setRowShown])

  /**
   * Splits the text into sections again and lines the rows up with them. Rows whose
   * section is unchanged keep their editors; their text is refreshed only if the way
   * it is shown changed (a heading or notes markers were typed).
   */
  const resync = useCallback((text: string, undoable = false) => {
    window.clearTimeout(resyncTimer.current)
    const sections = partition(text)
    const before = rows.current
    const run = changedRun(before.map((row) => row.text), sections.map((section) => section.text))
    const next: Row[] = sections.map((section, index) => {
      let reused: Row | undefined
      if (index < run.start) reused = before[index]
      else if (index >= run.endAfter) reused = before[index - run.endAfter + run.endBefore]
      else if (index < run.endBefore) reused = before[index]
      return makeRow(section, reused?.id)
    })
    applying.current = true
    try {
      for (const row of next) {
        for (const kind of ['output', 'notes'] as const) {
          const handle = handles.current.get(cellKey(row.id, kind))
          if (!handle || handle.getText() === row[kind].text) continue
          if (undoable) handle.replaceAll(row[kind].text)
          else handle.sync(row[kind].text)
        }
      }
    } finally {
      applying.current = false
    }
    rows.current = next
    const changed = next.length !== before.length
      || next.some((row, index) => row.id !== before[index].id || row.title !== before[index].title || row.named !== before[index].named)
    const preamble = showsPreamble(sections)
    setMeta((current) => (changed || current.preamble !== preamble ? { rows: next.map(metaOf), preamble } : current))
  }, [])

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

  const onCellChanges = useCallback((id: number, kind: CellKind, changes: ChangeSet, text: string) => {
    if (applying.current) {
      parent.current.onDocChanged()
      return
    }
    const row = rows.current.find((candidate) => candidate.id === id)
    if (!row) return
    row[kind] = applyChange(row[kind], text, changes)
    row.text = sectionText(row[kind])
    // The other side of this section was projected from the old text: project it again.
    const otherKind = other(kind)
    const fresh = project(row.text, otherKind)
    if (fresh.text !== row[otherKind].text) handles.current.get(cellKey(id, otherKind))?.sync(fresh.text)
    row[otherKind] = fresh
    if (kind === 'output' && row.title !== null && !row.named) {
      const heading = sectionTitle(row.text)
      if (heading !== null && heading !== row.title) {
        row.title = heading
        setMeta((current) => ({ ...current, rows: current.rows.map((item) => (item.id === id ? { ...item, title: heading } : item)) }))
      }
    }
    parent.current.onDocChanged()
  }, [])

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

  /** The rendered rows in order (the preamble row may be hidden). */
  const shownRows = useCallback(() => rows.current.filter((row, index) => index > 0 || row.title !== null || meta.preamble), [meta.preamble])

  /** Moves the cursor to the same side of the next or previous section. */
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
   * The line of a section's text where a new section would start: the line the cursor
   * (or the start of the selection) is on, or the next one with text if that line is
   * blank. Null when that is the section's first line, or the cursor is not in its text.
   */
  const splitLine = useCallback((id: number): number | null => {
    const row = rows.current.find((candidate) => candidate.id === id)
    const handle = handles.current.get(cellKey(id, 'output'))
    if (!row || !handle) return null
    const text = handle.getText()
    // A selection made downwards ends at the cursor; it starts a selection's length before.
    const cursor = handle.cursor()
    const selected = handle.getSelection()
    const start = selected && text.slice(cursor - selected.length, cursor) === selected ? cursor - selected.length : cursor
    const lines = text.split('\n')
    let line = text.slice(0, start).split('\n').length - 1
    while (line < lines.length && lines[line].trim() === '') line += 1
    return line > 0 && line < lines.length ? line : null
  }, [])

  /**
   * Shows the name box. Deferred, so a menu that is closing has given focus back
   * first: the box would otherwise lose focus at once, which cancels the rename.
   */
  const startRename = useCallback((id: number) => {
    window.setTimeout(() => setRenaming(id), 0)
  }, [])

  /** Starts a named section at the line `splitLine` finds, then asks for its name. */
  const splitAtCursor = useCallback((id: number) => {
    const index = rows.current.findIndex((row) => row.id === id)
    const row = rows.current[index]
    const line = splitLine(id)
    if (!row || line === null) return false
    const sectionLine = shownLineNumbers(row.output)[line]
    if (!applyText(splitSection(getText(), index, sectionLine, NEW_SECTION_NAME))) return false
    const created = rows.current[index + 1]
    if (created) startRename(created.id)
    return true
  }, [applyText, getText, splitLine, startRename])

  const keysFor = useCallback((id: number, kind: CellKind): KeyBinding[] => {
    const atEdge = (view: EditorView, forward: boolean) => {
      const range = view.state.selection.main
      return range.empty && view.moveVertically(range, forward).head === range.head
    }
    return [
      { key: 'ArrowDown', run: (view) => atEdge(view, true) && moveBetweenRows(id, kind, 1) },
      { key: 'ArrowUp', run: (view) => atEdge(view, false) && moveBetweenRows(id, kind, -1) },
      {
        key: 'Mod-Alt-n',
        run: () => {
          withCell(id, other(kind), (handle) => handle.focusAt(0))
          return true
        },
      },
      { key: 'Mod-Alt-s', run: () => kind === 'output' && splitAtCursor(id) },
    ]
  }, [moveBetweenRows, withCell, splitAtCursor])

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

  /** Shows `next` (the whole file) as suggestions in the editors whose text it changes. */
  const proposeFile = (next: string, label: string, additive: boolean): number => {
    const sections = partition(next)
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
      for (const kind of ['output', 'notes'] as const) {
        const current = row[kind].text
        const wanted = project(target, kind).text
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
      const inPrimary = shownLineNumbers(row[primary]).indexOf(offset)
      if (inPrimary >= 0) return reveal(primary, inPrimary)
      const inSecondary = shownLineNumbers(row[other(primary)]).indexOf(offset)
      if (inSecondary >= 0) return reveal(other(primary), inSecondary)
      const before = shownLineNumbers(row[primary]).filter((number) => number <= offset).length
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
      const offset = toSectionOffset(row[current.kind], handle.cursor())
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
      return joinSections(rows.current.slice(0, index)).length + (index > 0 ? 1 : 0) + toSectionOffset(rows.current[index][current.kind], handle.cursor())
    },
    focusAt: (offset) => {
      let start = 0
      for (const row of rows.current) {
        if (offset <= start + row.text.length) {
          const inside = offset - start
          for (const kind of [primary, other(primary)]) {
            const at = fromSectionOffset(row[kind], inside)
            if (at !== null) return withCell(row.id, kind, (handle) => handle.focusAt(at))
          }
          return withCell(row.id, primary, (handle) => handle.focusAt(0))
        }
        start += row.text.length + 1
      }
    },
    hasFocus: () => [...handles.current.values()].some((handle) => handle.hasFocus()),
  }))

  const secondary = other(primary)
  const sideName = { output: 'text', notes: 'notes' }

  /** The section menu for row `index` of `meta.rows`. */
  const menuFor = (index: number, shown: boolean, sized: boolean): MenuItem[] => {
    const rowMeta = meta.rows[index]
    const titled = rowMeta.title !== null
    const previous = meta.rows[index - 1]
    const nextRow = meta.rows[index + 1]
    const firstTitled = meta.rows[0]?.title === null ? 1 : 0
    const withText = (change: (text: string) => string | null, undoable = false) => () => applyText(change(getText()), undoable)
    const items: MenuItem[] = []
    if (titled) {
      items.push(
        { label: 'Rename section', onClick: () => startRename(rowMeta.id) },
        {
          label: 'Show name as a heading',
          checked: !rowMeta.named,
          title: 'A heading is part of the text (and of exports). Without one, the name only labels the section here.',
          // Not undoable in the editor: undoing there would drop the heading line and the section with it.
          onClick: withText((text) => setSectionHeading(text, index, rowMeta.named)),
        },
        'separator',
        { label: 'Move up', disabled: index <= firstTitled, onClick: withText((text) => moveSection(text, index, -1)) },
        { label: 'Move down', disabled: !nextRow, onClick: withText((text) => moveSection(text, index, 1)) },
        {
          label: `Merge into ${previous?.title ? `“${previous.title}”` : 'the text above'}`,
          disabled: !previous || (previous.title === null && !meta.preamble),
          title: rowMeta.named ? 'The name is removed' : 'The heading becomes a subheading',
          onClick: withText((text) => mergeIntoPrevious(text, index)),
        },
      )
    }
    items.push({
      label: nextRow ? `Merge “${nextRow.title}” into this` : 'Merge the next section into this',
      disabled: !nextRow,
      onClick: withText((text) => mergeIntoPrevious(text, index + 1)),
    })
    if (primary === 'output') {
      const inText = active.current?.id === rowMeta.id && active.current.kind === 'output'
      const possible = inText && splitLine(rowMeta.id) !== null
      items.push({
        label: 'New section from this paragraph',
        hint: 'Ctrl+Alt+S',
        disabled: !possible,
        title: possible
          ? 'Starts a named section at the paragraph the cursor is in'
          : inText ? 'The cursor is in the paragraph that already starts this section' : 'Put the cursor in a paragraph of this section first',
        onClick: () => splitAtCursor(rowMeta.id),
      })
    }
    items.push(
      'separator',
      { label: `${shown ? 'Hide' : 'Show'} the ${sideName[secondary]}`, onClick: () => setRowShown(rowMeta.title, !shown) },
      { label: 'Fit height to the text', disabled: !sized, onClick: () => setRowHeight(rowMeta.title, null) },
    )
    if (titled) {
      items.push('separator', {
        label: 'Delete section…',
        onClick: () => {
          const text = getText()
          if (!window.confirm(`Delete “${rowMeta.title}”, its text and its notes? An earlier version is kept in History.`)) return
          void window.verdandi.history.snapshot(path, text, `Before deleting “${rowMeta.title}”`).catch(() => {})
          applyText(deleteSection(text, index))
        },
      })
    }
    return items
  }

  return (
    <div className={`section-grid primary-${primary}${secondaryShown ? '' : ' secondary-off'}`}>
      {title && <h1 className="section-doc-title">{title}</h1>}
      {meta.rows.map((rowMeta, index) => {
        if (index === 0 && rowMeta.title === null && !meta.preamble) return null
        const key = rowKey(rowMeta.title)
        const shown = overrides[key] ?? secondaryShown
        const height = shown ? heights[key] : undefined
        return (
          <SectionRow
            key={rowMeta.id}
            id={rowMeta.id}
            title={rowMeta.title}
            named={rowMeta.named}
            primary={primary}
            secondary={secondary}
            shown={shown}
            height={height}
            renaming={renaming === rowMeta.id}
            menu={() => menuFor(index, shown, height !== undefined)}
            onRename={(name) => {
              setRenaming(null)
              if (name !== null) applyText(renameSection(getText(), index, name), true)
              withCell(rowMeta.id, 'output', (handle) => handle.focus())
            }}
            initialText={(kind) => rowById(rowMeta.id)?.[kind].text ?? ''}
            onShow={(value) => setRowShown(rowMeta.title, value)}
            onHeight={(value) => setRowHeight(rowMeta.title, value)}
            cell={(kind) => ({
              path,
              live,
              focusMode,
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
    </div>
  )
}

interface CellProps {
  path: string
  live: boolean
  focusMode: boolean
  register: (key: string, handle: MarkdownEditorHandle | null) => void
  keys: KeyBinding[]
  onChanges: (changes: ChangeSet, text: string) => void
  onSave: () => void
  onFocus: () => void
  onBlur: () => void
  onSelectWord: (word: WordInContext) => void
}

const PLACEHOLDER: Record<CellKind, string> = {
  output: 'Write here…',
  notes: 'Notes for this section…',
}

function Cell({ id, kind, initialText, props }: { id: number; kind: CellKind; initialText: () => string; props: CellProps }) {
  // The editor is made once with the text of the moment; later changes reach it through its handle.
  const [initial] = useState(initialText)
  const { register } = props
  const key = cellKey(id, kind)
  const attach = useCallback((handle: MarkdownEditorHandle | null) => register(key, handle), [register, key])
  return (
    <MarkdownEditor
      ref={attach}
      variant="cell"
      path={props.path}
      initialText={initial}
      placeholder={PLACEHOLDER[kind]}
      live={props.live}
      focusMode={props.focusMode}
      extraKeys={props.keys}
      onChanges={props.onChanges}
      onDocChanged={noop}
      onSave={props.onSave}
      onBlur={props.onBlur}
      onFocus={props.onFocus}
      onSelectWord={props.onSelectWord}
    />
  )
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

function SectionRow({
  id, title, named, primary, secondary, shown, height, renaming, menu, onRename, initialText, onShow, onHeight, cell,
}: {
  id: number
  title: string | null
  named: boolean
  primary: CellKind
  secondary: CellKind
  shown: boolean
  height: number | undefined
  renaming: boolean
  menu: () => MenuItem[]
  onRename: (name: string | null) => void
  initialText: (kind: CellKind) => string
  onShow: (shown: boolean) => void
  onHeight: (height: number | null) => void
  cell: (kind: CellKind) => CellProps
}) {
  const row = useRef<HTMLDivElement>(null)
  const primaryBody = useRef<HTMLDivElement>(null)
  const [, setMenuOpen] = useState(0)
  const sectionName = title ?? 'Before the first section'
  const kindName = { output: 'Text', notes: 'Notes' }

  // How tall the primary side's text is, for the secondary side when the two are stacked.
  useLayoutEffect(() => {
    const body = primaryBody.current
    const element = row.current
    if (!body || !element) return
    const observer = new ResizeObserver(() => element.style.setProperty('--fit-height', `${body.scrollHeight}px`))
    observer.observe(body.firstElementChild ?? body)
    return () => observer.disconnect()
  }, [])

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

  const menuButton = (
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

  // A heading in the text already names the section there; otherwise the name gets a line of its own.
  const nameLine = renaming || primary === 'notes' || named
  const style = height ? ({ '--row-height': `${height}px` } as CSSProperties) : undefined

  return (
    <div
      ref={row}
      className={`section-row${shown ? '' : ' secondary-hidden'}${height ? ' sized' : ''}${title === null ? ' section-preamble' : ''}${nameLine ? ' has-name-line' : ''}`}
      style={style}
      data-section={sectionName}
    >
      {nameLine && (
        <div className={`section-name-line${named ? ' named' : ''}`}>
          {renaming && title !== null ? (
            <NameInput initial={title} onDone={onRename} />
          ) : (
            <h2 className="section-name" title={named ? 'Section name (not a heading in the text)' : 'Section heading'}>{sectionName}</h2>
          )}
          <span className="section-name-rule" aria-hidden="true" />
          {menuButton}
        </div>
      )}
      <div className="section-cell section-primary">
        {!nameLine && <div className="section-menu-float">{menuButton}</div>}
        <div className="cell-body" ref={primaryBody}>
          <Cell key={primary} id={id} kind={primary} initialText={() => initialText(primary)} props={cell(primary)} />
        </div>
      </div>
      {shown ? (
        <div className="section-cell section-secondary">
          <div className="cell-frame">
            <div className="cell-caption">
              <span>{kindName[secondary]}</span>
              <button type="button" className="icon-button cell-hide" onClick={() => onShow(false)}
                title={`Hide the ${kindName[secondary].toLowerCase()} for “${sectionName}”`} aria-label={`Hide ${kindName[secondary].toLowerCase()}`}>
                <EyeOff size={13} aria-hidden="true" />
              </button>
            </div>
            <div className="cell-body">
              <Cell key={secondary} id={id} kind={secondary} initialText={() => initialText(secondary)} props={cell(secondary)} />
            </div>
          </div>
        </div>
      ) : (
        <button type="button" className="icon-button section-show" onClick={() => onShow(true)}
          title={`Show the ${kindName[secondary].toLowerCase()} for “${sectionName}”`} aria-label={`Show ${kindName[secondary].toLowerCase()}`}>
          <PanelRightOpen size={14} aria-hidden="true" />
        </button>
      )}
      {shown && (
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
