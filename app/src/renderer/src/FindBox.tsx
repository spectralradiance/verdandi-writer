import { CaseSensitive, ChevronDown, ChevronRight, ChevronUp, Regex, WholeWord, X } from 'lucide-react'
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { type FindQuery, type FindResult, MATCH_LIMIT } from './editor/find'
import type { MarkdownEditorHandle } from './editor/MarkdownEditor'

interface FindBoxProps {
  /** The editor searched: the box (or section layer) that last had the focus. */
  target: () => MarkdownEditorHandle | null
  /** The text to start with: the selection when the box was opened, if any. */
  seed: string
  /** Bumped each time Ctrl+F is pressed, to focus and select the field again. */
  focusKey: number
  readOnly: boolean
  onClose: () => void
}

const NONE: FindResult = { total: 0, current: 0, invalid: false }

/**
 * The floating find box (Ctrl+F), in the document's top right corner: it finds in
 * the editor that last had the focus, highlighting every match, and can replace.
 * Enter goes to the next match, Shift+Enter the previous; Escape closes it and puts
 * the cursor back in the editor, on the match.
 */
export function FindBox({ target, seed, focusKey, readOnly, onClose }: FindBoxProps) {
  const [text, setText] = useState(seed)
  const [replacement, setReplacement] = useState('')
  const [options, setOptions] = useState({ caseSensitive: false, wholeWord: false, regexp: false })
  const [replacing, setReplacing] = useState(false)
  const [result, setResult] = useState<FindResult>(NONE)
  const field = useRef<HTMLInputElement>(null)
  const query: FindQuery = { text, ...options }

  // Ctrl+F again, with the box open: back to its field, all of it selected (and the new selection, if there is one).
  useLayoutEffect(() => {
    field.current?.focus()
    field.current?.select()
  }, [focusKey])

  // Each change to what is looked for highlights it again, and selects the first match from the cursor.
  const queryKey = JSON.stringify(query)
  const latest = useRef({ target, query })
  useLayoutEffect(() => {
    latest.current = { target, query }
  })
  useEffect(() => {
    const { target: current, query: next } = latest.current
    const editor = current()
    if (!editor) return
    const found = editor.find(next)
    setResult(found.total > 0 && found.current === 0 ? editor.findStep(1) : found)
  }, [queryKey])

  // Closing clears the highlights.
  useEffect(() => () => {
    latest.current.target()?.find(null)
  }, [])

  const step = (direction: 1 | -1) => {
    const editor = target()
    if (!editor) return
    editor.find(query)
    setResult(editor.findStep(direction))
  }
  const replaceOne = () => {
    const editor = target()
    if (editor) setResult(editor.replaceStep(query, replacement))
  }
  const replaceAll = () => {
    const editor = target()
    if (!editor) return
    editor.replaceEvery(query, replacement)
    setResult(editor.find(query))
  }
  const close = () => {
    target()?.focus()
    onClose()
  }

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
    } else if (event.key === 'Enter' && event.target === field.current) {
      event.preventDefault()
      step(event.shiftKey ? -1 : 1)
    } else if (event.key === 'Enter' && (event.target as HTMLElement).classList.contains('find-replace-field')) {
      event.preventDefault()
      if (event.ctrlKey || event.metaKey) replaceAll()
      else replaceOne()
    }
  }

  const count = result.invalid
    ? 'Not a valid pattern'
    : !text
      ? ''
      : result.total === 0
        ? 'No results'
        : `${result.current || '?'} of ${result.total >= MATCH_LIMIT ? `${MATCH_LIMIT}+` : result.total}`
  const toggle = (name: keyof typeof options, label: string, Icon: typeof CaseSensitive) => (
    <button type="button" className={`icon-button find-option${options[name] ? ' on' : ''}`} aria-pressed={options[name]} title={label} aria-label={label}
      onClick={() => setOptions((current) => ({ ...current, [name]: !current[name] }))}>
      <Icon size={15} aria-hidden="true" />
    </button>
  )

  return (
    <div className="find-box" role="search" aria-label="Find in this box" onKeyDown={onKeyDown}>
      <div className="find-row">
        {!readOnly && (
          <button type="button" className="icon-button find-expand" aria-expanded={replacing} title={replacing ? 'Hide replace' : 'Replace'}
            aria-label="Replace" onClick={() => setReplacing((current) => !current)}>
            <ChevronRight size={14} aria-hidden="true" className={replacing ? 'open' : ''} />
          </button>
        )}
        <input ref={field} className="find-field" value={text} placeholder="Find" aria-label="Find" spellCheck={false}
          onChange={(event) => setText(event.target.value)} />
        {toggle('caseSensitive', 'Match case', CaseSensitive)}
        {toggle('wholeWord', 'Whole words', WholeWord)}
        {toggle('regexp', 'Regular expression', Regex)}
        <span className={`find-count${result.total === 0 && text ? ' none' : ''}`} aria-live="polite">{count}</span>
        <button type="button" className="icon-button" title="Previous (Shift+Enter)" aria-label="Previous match" disabled={result.total === 0} onClick={() => step(-1)}>
          <ChevronUp size={15} aria-hidden="true" />
        </button>
        <button type="button" className="icon-button" title="Next (Enter)" aria-label="Next match" disabled={result.total === 0} onClick={() => step(1)}>
          <ChevronDown size={15} aria-hidden="true" />
        </button>
        <button type="button" className="icon-button" title="Close (Escape)" aria-label="Close find" onClick={close}>
          <X size={15} aria-hidden="true" />
        </button>
      </div>
      {replacing && !readOnly && (
        <div className="find-row find-replace-row">
          <input className="find-field find-replace-field" value={replacement} placeholder="Replace" aria-label="Replace with" spellCheck={false}
            onChange={(event) => setReplacement(event.target.value)} />
          <button type="button" className="find-text-button" disabled={result.total === 0} title="Replace this match (Enter)" onClick={replaceOne}>Replace</button>
          <button type="button" className="find-text-button" disabled={result.total === 0} title="Replace every match in this box (Ctrl+Enter)" onClick={replaceAll}>All</button>
        </div>
      )}
    </div>
  )
}
