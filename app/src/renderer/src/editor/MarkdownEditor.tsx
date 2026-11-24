import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { Annotation, type ChangeSet, Compartment, EditorSelection, EditorState, Prec, Transaction } from '@codemirror/state'
import { drawSelection, dropCursor, EditorView, type KeyBinding, keymap, placeholder as placeholderText } from '@codemirror/view'
import { type Ref, useEffectEvent, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'

import { isSingleWord, matchCase, sentenceAround, wordAt } from '../../../shared/text'
import { toggleWrap } from './commands'
import { findExtension, type FindQuery, type FindResult, findStep, replaceEvery, replaceStep, setFindQuery } from './find'
import { dictionaryHover } from './dictionaryHover'
import { documentTitle } from './documentTitle'
import { focusMode as focusModeExtension } from './focusMode'
import { documentPath, imageFolder as imageFolderFacet, livePreview } from './livePreview'
import { addOrJumpToNotes, notesBlocks, notesView as notesViewFacet, type NotesView, revealSelection, SHOW_NOTES_EVENT } from './notesBlocks'
import { proposeRangeSpec, proposeText, suggestions, suggestionsOf } from './suggestions'
import { cellTheme, editorTheme } from './theme'

const NO_MATCHES: FindResult = { total: 0, current: 0, invalid: false }

/** Marks text set from outside (another view of the same file), which is not an edit to report or undo. */
const syncAnnotation = Annotation.define<boolean>()

/** The smallest change that turns `current` into `text`. */
function minimalChange(current: string, text: string): { from: number; to: number; insert: string } {
  let start = 0
  while (start < current.length && start < text.length && current[start] === text[start]) start += 1
  let end = 0
  while (end < current.length - start && end < text.length - start
    && current[current.length - 1 - end] === text[text.length - 1 - end]) end += 1
  return { from: start, to: current.length - end, insert: text.slice(start, text.length - end) }
}

export interface MarkdownEditorHandle {
  getText(): string
  focus(): void
  /** Puts the cursor at the start of a 1-based line and scrolls it to the top. */
  revealLine(line: number): void
  /** The selected word, or the word at the cursor, with the sentence it sits in. */
  currentWord(): WordInContext | null
  /** Replaces the selection, or the word at the cursor, matching its capitalization. */
  replaceWord(replacement: string): boolean
  getSelection(): string
  /** Replaces the whole document as one undoable change (only the part that differs is touched). */
  replaceAll(text: string): void
  /** The 1-based line the cursor is on. */
  cursorLine(): number
  /** Shows the edits that would turn the text into `text` as suggestions to accept or reject; returns how many. */
  propose(text: string, label: string): number
  /** Suggests replacing [from, to) with `insert`, keeping other suggestions; returns how many changes. */
  proposeRange(from: number, to: number, insert: string, label: string): number
  /** How many suggestions are waiting. */
  pendingSuggestions(): number
  /** Sets the text from outside without reporting it as an edit or adding it to undo. */
  sync(text: string): void
  /** The cursor's offset. */
  cursor(): number
  /** Puts the cursor at an offset, scrolls to it and focuses the editor. */
  focusAt(offset: number): void
  hasFocus(): boolean
  /** Highlights every match of `query` (the find box's), or clears them (null). */
  find(query: FindQuery | null): FindResult
  /** Selects the next (1) or previous (-1) match, wrapping around. */
  findStep(direction: 1 | -1): FindResult
  /** Replaces the selected match and selects the next one. */
  replaceStep(query: FindQuery, replacement: string): FindResult
  /** Replaces every match; returns how many there were. */
  replaceEvery(query: FindQuery, replacement: string): number
}

export interface WordInContext {
  word: string
  context: string
}

function wordInContext(state: EditorState): (WordInContext & { from: number; to: number }) | null {
  const selection = state.selection.main
  const line = state.doc.lineAt(selection.head)
  if (!selection.empty) {
    const text = state.sliceDoc(selection.from, selection.to).trim()
    if (!isSingleWord(text) || state.doc.lineAt(selection.from).number !== line.number) return null
    return { word: text, context: sentenceAround(line.text, selection.from - line.from, selection.to - line.from), from: selection.from, to: selection.to }
  }
  const match = wordAt(line.text, selection.head - line.from)
  if (!match) return null
  return { word: match.word, context: sentenceAround(line.text, match.from, match.to), from: line.from + match.from, to: line.from + match.to }
}

interface MarkdownEditorProps {
  ref?: Ref<MarkdownEditorHandle>
  path: string
  /** The folder images resolve against, when not the file's folder (a document folder's own path). Fixed when the editor is made. */
  imageFolder?: string
  initialText: string
  placeholder?: string
  /** The document's title, shown above the text without being part of it. */
  title?: string
  live: boolean
  focusMode: boolean
  /** Show the text alone, the notes alone, or both (see notesBlocks). */
  notesView?: NotesView
  /** A command needs the notes view (Ctrl+Alt+N in the output view). */
  onShowNotes?: () => void
  onDocChanged: () => void
  onSave: () => void
  onBlur: () => void
  onFocus?: () => void
  /** A single word was selected (for following lookups in the lexical panel). */
  onSelectWord?: (word: WordInContext) => void
  /** 'cell' is one section's text or notes in the two-column view: compact, as tall as its text. */
  variant?: 'document' | 'cell'
  /** Key bindings that run before the editor's own. */
  extraKeys?: readonly KeyBinding[]
  /** The text was edited, with the changes (not called for `sync`). */
  onChanges?: (changes: ChangeSet, text: string) => void
  /** Shown and selectable, but not editable. Fixed when the editor is made. */
  readOnly?: boolean
}

const noop = () => {}

/**
 * Uncontrolled CodeMirror editor. The parent reads the text through the handle
 * instead of receiving it on every keystroke, which keeps large notes fast.
 */
export function MarkdownEditor({
  ref, path, imageFolder, initialText, placeholder, title = '', live, focusMode, notesView = 'all', onShowNotes, onDocChanged, onSave, onBlur, onFocus, onSelectWord,
  variant = 'document', extraKeys, onChanges, readOnly = false,
}: MarkdownEditorProps) {
  const container = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const [compartments] = useState(() => ({ live: new Compartment(), focus: new Compartment(), notes: new Compartment(), title: new Compartment() }))
  const handleDocChanged = useEffectEvent(onDocChanged)
  const handleSave = useEffectEvent(onSave)
  const handleBlur = useEffectEvent(onBlur)
  const handleFocus = useEffectEvent(onFocus ?? noop)
  const handleSelectWord = useEffectEvent((word: WordInContext) => onSelectWord?.(word))
  const handleShowNotes = useEffectEvent(onShowNotes ?? noop)
  const handleChanges = useEffectEvent((changes: ChangeSet, text: string) => onChanges?.(changes, text))
  // Read through a ref so the bindings can change without rebuilding the editor.
  const keys = useRef(extraKeys)
  useLayoutEffect(() => {
    keys.current = extraKeys
  })

  useImperativeHandle(ref, () => ({
    getText: () => view.current?.state.doc.toString() ?? initialText,
    focus: () => view.current?.focus(),
    revealLine: (number) => {
      const editor = view.current
      if (!editor) return
      const line = editor.state.doc.line(Math.max(1, Math.min(number, editor.state.doc.lines)))
      editor.dispatch({
        selection: { anchor: line.from },
        effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 24 }),
      })
      editor.focus()
    },
    currentWord: () => {
      const editor = view.current
      if (!editor) return null
      const found = wordInContext(editor.state)
      return found ? { word: found.word, context: found.context } : null
    },
    replaceWord: (replacement) => {
      const editor = view.current
      const found = editor ? wordInContext(editor.state) : null
      if (!editor || !found) return false
      const insert = matchCase(found.word, replacement)
      editor.dispatch({
        changes: { from: found.from, to: found.to, insert },
        selection: EditorSelection.range(found.from, found.from + insert.length),
        userEvent: 'input.replace',
      })
      editor.focus()
      return true
    },
    getSelection: () => {
      const editor = view.current
      if (!editor) return ''
      return editor.state.selection.ranges.map((range) => editor.state.sliceDoc(range.from, range.to)).join('\n')
    },
    replaceAll: (text) => {
      const editor = view.current
      if (!editor) return
      editor.dispatch({
        changes: minimalChange(editor.state.doc.toString(), text),
        userEvent: 'input.replace',
        scrollIntoView: true,
      })
    },
    sync: (text) => {
      const editor = view.current
      if (!editor) return
      const current = editor.state.doc.toString()
      if (current === text) return
      editor.dispatch({
        changes: minimalChange(current, text),
        annotations: [syncAnnotation.of(true), Transaction.addToHistory.of(false)],
      })
    },
    cursor: () => view.current?.state.selection.main.head ?? 0,
    focusAt: (offset) => {
      const editor = view.current
      if (!editor) return
      const position = Math.max(0, Math.min(offset, editor.state.doc.length))
      editor.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: 'nearest', yMargin: 48 }) })
      editor.focus()
    },
    hasFocus: () => view.current?.hasFocus ?? false,
    find: (query) => (view.current ? setFindQuery(view.current, query) : NO_MATCHES),
    findStep: (direction) => (view.current ? findStep(view.current, direction) : NO_MATCHES),
    replaceStep: (query, replacement) => (view.current ? replaceStep(view.current, query, replacement) : NO_MATCHES),
    replaceEvery: (query, replacement) => (view.current ? replaceEvery(view.current, query, replacement) : 0),
    cursorLine: () => {
      const editor = view.current
      return editor ? editor.state.doc.lineAt(editor.state.selection.main.head).number : 1
    },
    propose: (text, label) => (view.current ? proposeText(view.current, text, label) : 0),
    proposeRange: (from, to, insert, label) => {
      const editor = view.current
      if (!editor) return 0
      const { count, ...spec } = proposeRangeSpec(editor.state, from, to, insert, label)
      if (count) editor.dispatch(spec)
      return count
    },
    pendingSuggestions: () => (view.current ? suggestionsOf(view.current.state).length : 0),
  }), [initialText])

  useLayoutEffect(() => {
    if (!container.current) return
    const state = EditorState.create({
      doc: initialText,
      extensions: [
        documentPath.of(path),
        imageFolderFacet.of(imageFolder ?? ''),
        EditorState.readOnly.of(readOnly),
        history(),
        drawSelection(),
        dropCursor(),
        EditorView.lineWrapping,
        markdown({ base: markdownLanguage, codeLanguages: languages }),
        search({ top: true }),
        findExtension,
        highlightSelectionMatches(),
        compartments.live.of([]),
        compartments.focus.of([]),
        compartments.notes.of([]),
        compartments.title.of([]),
        notesBlocks,
        suggestions,
        editorTheme,
        variant === 'cell' ? cellTheme : [],
        // The keys are fixed when the editor is made; what they run is read when pressed.
        Prec.high(keymap.of((keys.current ?? []).map((binding) => ({
          key: binding.key,
          run: (editor: EditorView) => keys.current?.find((current) => current.key === binding.key)?.run?.(editor) ?? false,
        })))),
        EditorView.contentAttributes.of({ spellcheck: 'true', autocorrect: 'off', autocapitalize: 'off' }),
        placeholder ? placeholderText(placeholder) : [],
        dictionaryHover,
        keymap.of([
          { key: 'Mod-s', preventDefault: true, run: () => { handleSave(); return true } },
          { key: 'Mod-b', run: toggleWrap('**') },
          { key: 'Mod-i', run: toggleWrap('*') },
          { key: 'Mod-`', run: toggleWrap('`') },
          { key: 'Mod-Alt-n', run: addOrJumpToNotes },
          // Ctrl+F opens the find box over the document (App.tsx), not CodeMirror's panel.
          ...searchKeymap.filter((binding) => binding.key !== 'Mod-f'),
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !update.transactions.some((transaction) => transaction.annotation(syncAnnotation))) {
            handleDocChanged()
            handleChanges(update.changes, update.state.doc.toString())
          }
          if (update.selectionSet && !update.state.selection.main.empty) {
            const found = wordInContext(update.state)
            if (found) handleSelectWord({ word: found.word, context: found.context })
          }
          if (update.focusChanged) {
            if (update.view.hasFocus) handleFocus()
            else handleBlur()
          }
        }),
      ],
    })
    const editor = new EditorView({ state, parent: container.current })
    view.current = editor
    const showNotes = () => handleShowNotes()
    editor.dom.addEventListener(SHOW_NOTES_EVENT, showNotes)
    return () => {
      editor.dom.removeEventListener(SHOW_NOTES_EVENT, showNotes)
      editor.destroy()
      view.current = null
    }
  }, [path, imageFolder, initialText, placeholder, compartments, variant, readOnly])

  useLayoutEffect(() => {
    view.current?.dispatch({ effects: compartments.live.reconfigure(live ? livePreview : []) })
  }, [live, compartments, path, initialText])

  useLayoutEffect(() => {
    view.current?.dispatch({ effects: compartments.title.reconfigure(documentTitle(title)) })
  }, [title, compartments, path, initialText])

  useLayoutEffect(() => {
    view.current?.dispatch({ effects: compartments.focus.reconfigure(focusMode ? focusModeExtension : []) })
  }, [focusMode, compartments, path, initialText])

  useLayoutEffect(() => {
    const editor = view.current
    if (!editor) return
    editor.dispatch({ effects: compartments.notes.reconfigure(notesViewFacet.of(notesView)) })
    revealSelection(editor)
  }, [notesView, compartments, path, initialText])

  return <div className={variant === 'cell' ? 'cell-host' : 'editor-host'} ref={container} />
}

