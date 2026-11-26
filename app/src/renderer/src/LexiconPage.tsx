import { BookOpen, Check, Plus, Search, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import type { DictionaryEntry, DictionarySearchResult, LexiconEntry } from '../../shared/ipc'
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
type Selection = { kind: 'saved'; word: string } | { kind: 'new'; word: string; definition: string; key: number } | null

const same = (a: string, b: string) => a.toLocaleLowerCase() === b.toLocaleLowerCase()

/** A search result's first sense (its senses are joined by `|`), or nothing if cut short (the dictionary's own is used then). */
const firstSense = (gloss: string) => {
  const sense = gloss.split(' | ')[0].trim()
  return sense.includes('…') ? '' : sense
}

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
  const [dictionary, setDictionary] = useState<{ word: string; entries: DictionaryEntry[] } | null>(null)
  const [available, setAvailable] = useState(false)
  const [found, setFound] = useState<{ query: string; results: DictionarySearchResult[] } | null>(null)

  useEffect(() => {
    void window.verdandi.dictionary.status().then((status) => setAvailable(status.available), () => {})
  }, [])

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

  // The dictionary's entry for the word shown (saved, or being added), beside it.
  const lookupWord = entry?.word ?? (selected?.kind === 'new' && selected.word.trim() ? selected.word.trim() : null)
  useEffect(() => {
    if (!lookupWord || !available) return
    let active = true
    window.verdandi.dictionary.lookup(lookupWord).then(
      (entries) => { if (active) setDictionary({ word: lookupWord, entries }) },
      () => { if (active) setDictionary(null) },
    )
    return () => {
      active = false
    }
  }, [lookupWord, available])
  const dictionaryEntries = dictionary && lookupWord && same(dictionary.word, lookupWord) ? dictionary.entries : []

  // Words in the dictionary that start with what is typed, to add to the saved words.
  useEffect(() => {
    if (!plainQuery || !available) return
    let active = true
    const timer = window.setTimeout(() => {
      window.verdandi.dictionary.search(plainQuery, 30).then((results) => { if (active) setFound({ query: plainQuery, results }) }, () => {})
    }, 200)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [plainQuery, available])
  const dictionaryResults = found && plainQuery && found.query === plainQuery ? found.results : []
  const savedWords = useMemo(() => new Map(lexicon.map((item) => [item.word.toLocaleLowerCase(), item.word])), [lexicon])

  const addNew = (word: string, definition = '') => setSelected({ kind: 'new', word, definition, key: Date.now() })

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
            <input value={query} autoFocus placeholder="Search saved words and the dictionary · tag: syn: word: def:" aria-label="Search saved words and the dictionary"
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
          <div className="lexicon-page-scroll">
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
            {dictionaryResults.length > 0 && (
              <>
                <h3 className="lexical-section-title lexicon-found-title"><BookOpen size={13} aria-hidden="true" /> In the dictionary</h3>
                <ul className="lexicon-list lexicon-found">
                  {dictionaryResults.map((result, index) => {
                    const saved = savedWords.get(result.word.toLocaleLowerCase())
                    return (
                      <li key={`${result.word}|${result.pos ?? ''}|${index}`}>
                        <button type="button" title={saved ? 'Already saved: show it' : `Add “${result.word}” to your saved words`}
                          aria-current={selected?.kind === 'new' && same(selected.word, result.word) ? 'true' : undefined}
                          onClick={() => (saved ? setSelected({ kind: 'saved', word: saved }) : addNew(result.word, firstSense(result.gloss)))}>
                          <strong>{result.word} {saved ? <Check size={12} aria-label="saved" /> : <Plus size={12} aria-label="add" />}</strong>
                          {result.pos && <em>{result.pos}</em>}
                          <span>{result.gloss}</span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </>
            )}
          </div>
        </aside>
        <section className="lexicon-page-entry">
          {message && <p className="lexical-message">{message}</p>}
          {selected?.kind === 'new' && (
            <LexiconForm key={selected.key} word={selected.word} definition={selected.definition} context="" source={null} entries={null} saved={null} editableWord
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
            </>
          )}
          {dictionaryEntries.length > 0 && (
            <div className="lexicon-page-dictionary">
              <h3 className="lexical-section-title">In the dictionary</h3>
              {dictionaryEntries.slice(0, 4).map((item) => (
                <section key={item.id} className="lexical-entry">
                  <h3>{item.pos ?? 'unclassified'}</h3>
                  <ol>
                    {item.senses.filter((sense) => sense.glosses.length > 0).slice(0, 6).map((sense, index) => <li key={index}>{sense.glosses.join('; ')}</li>)}
                  </ol>
                </section>
              ))}
            </div>
          )}
          {!selected && <p className="lexical-message">Choose a word, or add a new one.</p>}
        </section>
      </div>
    </Modal>
  )
}
