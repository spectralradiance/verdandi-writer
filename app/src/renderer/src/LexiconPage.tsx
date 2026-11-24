import { Plus, Search, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import type { DictionaryEntry, LexiconEntry } from '../../shared/ipc'
import { matchesLexiconQuery } from '../../shared/lexicon'
import { LexiconForm } from './LexiconForm'
import { Modal } from './Modal'

interface LexiconPageProps {
  lexicon: LexiconEntry[]
  /** The word to show first, if any. */
  initialWord?: string | null
  onChanged: () => void
  /** Opens a word in the Words panel (and closes this page). */
  onLookup: (word: string) => void
  onClose: () => void
}

type Order = 'alphabet' | 'newest' | 'oldest'

/** What the right side shows: a saved word, or a new one being added (with what was typed). */
type Selection = { kind: 'saved'; word: string } | { kind: 'new'; word: string; key: number } | null

const same = (a: string, b: string) => a.toLocaleLowerCase() === b.toLocaleLowerCase()

/**
 * The saved words on a page of their own: search them (with the `tag:`, `syn:`,
 * `word:` and `def:` prefixes), narrow them by tag, sort them, and read, edit or
 * add a word beside the list.
 */
export function LexiconPage({ lexicon, initialWord, onChanged, onLookup, onClose }: LexiconPageProps) {
  const [query, setQuery] = useState('')
  const [tag, setTag] = useState<string | null>(null)
  const [order, setOrder] = useState<Order>('alphabet')
  const [selected, setSelected] = useState<Selection>(() => {
    const found = initialWord ? lexicon.find((entry) => same(entry.word, initialWord)) : undefined
    return found ? { kind: 'saved', word: found.word } : lexicon[0] ? { kind: 'saved', word: lexicon[0].word } : null
  })
  const [message, setMessage] = useState<string | null>(null)
  const [dictionary, setDictionary] = useState<DictionaryEntry[] | null>(null)

  const tags = useMemo(() => {
    const counts = new Map<string, number>()
    for (const entry of lexicon) for (const name of entry.tags) counts.set(name, (counts.get(name) ?? 0) + 1)
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }, [lexicon])

  const shown = useMemo(() => {
    const list = lexicon.filter((entry) => matchesLexiconQuery(entry, query) && (tag === null || entry.tags.includes(tag)))
    if (order !== 'alphabet') list.sort((a, b) => (order === 'newest' ? -1 : 1) * a.added.localeCompare(b.added) || a.word.localeCompare(b.word))
    return list
  }, [lexicon, query, tag, order])

  const entry = selected?.kind === 'saved' ? lexicon.find((item) => same(item.word, selected.word)) ?? null : null
  const plainQuery = query.trim() && !query.includes(':') ? query.trim() : ''
  const exact = plainQuery ? lexicon.find((item) => same(item.word, plainQuery)) : undefined

  // The dictionary's entry for the word shown, beside the saved one.
  const lookupWord = entry?.word ?? null
  useEffect(() => {
    if (!lookupWord) return
    let active = true
    window.verdandi.dictionary.lookup(lookupWord).then((found) => { if (active) setDictionary(found) }, () => { if (active) setDictionary(null) })
    return () => {
      active = false
    }
  }, [lookupWord])

  const addNew = (word: string) => setSelected({ kind: 'new', word, key: Date.now() })

  return (
    <Modal label="Saved words" className="lexicon-page" onClose={onClose}>
      <header className="modal-header">
        <h2>Saved words <span className="lexical-hint">{lexicon.length.toLocaleString()}</span></h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={14} aria-hidden="true" /></button>
      </header>
      <div className="lexicon-page-body">
        <aside className="lexicon-page-list">
          <div className="lexicon-page-search">
            <Search size={14} aria-hidden="true" />
            <input value={query} autoFocus placeholder="Search · tag: syn: word: def:" aria-label="Search saved words"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return
                if (exact) setSelected({ kind: 'saved', word: exact.word })
                else if (plainQuery) addNew(plainQuery)
              }} />
          </div>
          <div className="lexicon-page-tools">
            <select value={order} onChange={(event) => setOrder(event.target.value as Order)} aria-label="Order">
              <option value="alphabet">A to Z</option>
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
            </select>
            <span className="lexical-hint">{shown.length.toLocaleString()} shown</span>
            <button type="button" className="find-text-button" onClick={() => addNew(plainQuery && !exact ? plainQuery : '')}>
              <Plus size={13} aria-hidden="true" /> New word
            </button>
          </div>
          {tags.length > 0 && (
            <div className="lexicon-page-tags">
              {tags.map(([name, count]) => (
                <button key={name} type="button" className="term-chip" aria-pressed={tag === name} onClick={() => setTag(tag === name ? null : name)}>
                  {name} <span className="lexical-hint">{count}</span>
                </button>
              ))}
            </div>
          )}
          <ul className="lexicon-list">
            {plainQuery && !exact && (
              <li>
                <button type="button" className="lexicon-add" onClick={() => addNew(plainQuery)}><Plus size={13} aria-hidden="true" /> Add “{plainQuery}”</button>
              </li>
            )}
            {shown.map((item) => (
              <li key={item.word}>
                <button type="button" aria-current={selected?.kind === 'saved' && same(selected.word, item.word) ? 'true' : undefined}
                  onClick={() => setSelected({ kind: 'saved', word: item.word })}>
                  <strong>{item.word}</strong>
                  {item.tags.length > 0 && <em>{item.tags.join(', ')}</em>}
                  <span>{item.definition}</span>
                </button>
              </li>
            ))}
            {lexicon.length === 0 && <li className="lexical-message">No saved words yet. Type one above to add it.</li>}
          </ul>
        </aside>
        <section className="lexicon-page-entry">
          {message && <p className="lexical-message">{message}</p>}
          {selected?.kind === 'new' && (
            <LexiconForm key={selected.key} word={selected.word} context="" source={null} entries={null} saved={null} editableWord
              onSaved={(text, word) => {
                setMessage(text)
                onChanged()
                if (word) setSelected({ kind: 'saved', word })
              }} />
          )}
          {entry && (
            <>
              <LexiconForm key={`${entry.word}|${entry.added}`} word={entry.word} context="" source={null} entries={null} saved={entry}
                onSaved={(text, word) => {
                  setMessage(text)
                  onChanged()
                  if (!word) setSelected(null)
                }} />
              <button type="button" className="link-button" onClick={() => onLookup(entry.word)}>Open in the Words panel</button>
              {entry.source && <p className="lexical-hint" title={entry.source}>From {entry.source}{entry.added ? ` · saved ${entry.added}` : ''}</p>}
              {dictionary && dictionary.length > 0 && (
                <div className="lexicon-page-dictionary">
                  <h3 className="lexical-section-title">In the dictionary</h3>
                  {dictionary.slice(0, 4).map((found) => (
                    <section key={found.id} className="lexical-entry">
                      <h3>{found.pos ?? 'unclassified'}</h3>
                      <ol>
                        {found.senses.filter((sense) => sense.glosses.length > 0).slice(0, 6).map((sense, index) => <li key={index}>{sense.glosses.join('; ')}</li>)}
                      </ol>
                    </section>
                  ))}
                </div>
              )}
            </>
          )}
          {!selected && <p className="lexical-message">Choose a word, or add a new one.</p>}
        </section>
      </div>
    </Modal>
  )
}
