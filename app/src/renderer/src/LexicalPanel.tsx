import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { parseEtymology } from '../../shared/etymology'
import type { DictionaryDownload, DictionaryEntry, DictionarySearchResult, DictionaryStatus, LexiconEntry } from '../../shared/ipc'
import { readPref, writePref } from './prefs'
import { LexiconForm } from './LexiconForm'
import { LexiconPage } from './LexiconPage'
import { errorMessage } from './target'
import { ArrowLeft, BookMarked } from 'lucide-react'

export interface LexicalQuery {
  word: string
  /** Sentence the word came from, saved with lexicon entries. */
  context: string
  source: string | null
}

type Part = 'define' | 'etymology' | 'thesaurus' | 'lexicon' | 'external'

const PARTS: { id: Part; label: string }[] = [
  { id: 'define', label: 'Define' },
  { id: 'etymology', label: 'Etymology' },
  { id: 'thesaurus', label: 'Thesaurus' },
  { id: 'lexicon', label: 'Lexicon' },
  { id: 'external', label: 'Web' },
]

// Dictionary sites, https only.
const EXTERNAL_SITES: { label: string; url: (word: string) => string }[] = [
  { label: 'Wiktionary', url: (word) => `https://en.wiktionary.org/wiki/${encodeURIComponent(word)}` },
  { label: 'Etymonline', url: (word) => `https://www.etymonline.com/search?q=${encodeURIComponent(word)}` },
  { label: 'Merriam-Webster', url: (word) => `https://www.merriam-webster.com/dictionary/${encodeURIComponent(word)}` },
  { label: 'Merriam-Webster Thesaurus', url: (word) => `https://www.merriam-webster.com/thesaurus/${encodeURIComponent(word)}` },
  { label: 'Dictionary.com', url: (word) => `https://www.dictionary.com/browse/${encodeURIComponent(word)}` },
  { label: 'Thesaurus.com', url: (word) => `https://www.thesaurus.com/browse/${encodeURIComponent(word)}` },
  { label: 'RhymeZone', url: (word) => `https://www.rhymezone.com/r/rhyme.cgi?Word=${encodeURIComponent(word)}&typeofrhyme=perfect` },
]

function wiktionaryUrl(term: string, language: string): string {
  const page = term.replace(/^\*/, 'Reconstruction:' + language.replace(/ /g, '_') + '/')
  return `https://en.wiktionary.org/wiki/${encodeURIComponent(page).replace(/%2F/g, '/').replace(/%3A/g, ':')}#${encodeURIComponent(language.replace(/ /g, '_'))}`
}

const megabytes = (bytes: number) => `${Math.round(bytes / 1_048_576).toLocaleString()} MB`

/** Offers to download Wiktionary and build the dictionary from it, with progress. */
function DictionaryDownloader({ onReady }: { onReady: (status: DictionaryStatus) => void }) {
  const [progress, setProgress] = useState<DictionaryDownload | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const busy = progress !== null && (progress.state === 'downloading' || progress.state === 'indexing')

  useEffect(() => window.verdandi.dictionary.onDownload(setProgress), [])

  const start = () => {
    setFailure(null)
    window.verdandi.dictionary.download().then(onReady, (reason: unknown) => setFailure(errorMessage(reason)))
  }

  return (
    <div className="dictionary-download">
      {busy ? (
        <>
          <progress value={progress.total ? progress.received : undefined} max={progress.total ?? undefined} />
          <p>
            {progress.state === 'indexing'
              ? 'Building the search index…'
              : `Downloading Wiktionary: ${megabytes(progress.received)}${progress.total ? ` of ${megabytes(progress.total)}` : ''} · ${progress.entries.toLocaleString()} entries`}
          </p>
          <button type="button" disabled={progress.state === 'indexing'} onClick={() => void window.verdandi.dictionary.cancelDownload()}>Cancel</button>
        </>
      ) : (
        <>
          <button type="button" onClick={start}>Download Wiktionary</button>
          <p className="lexical-hint">A one-time download of about 2.5 GB from kaikki.org; it becomes a database of roughly 1 GB on this computer.</p>
        </>
      )}
      {failure && <p className="status-error">{failure}</p>}
    </div>
  )
}

interface LexicalPanelProps {
  query: LexicalQuery | null
  onLookup: (word: string) => void
  /** Replaces the current word in the active editor; false if there is none. */
  onReplace: (word: string) => boolean
}

export function LexicalPanel({ query, onLookup, onReplace }: LexicalPanelProps) {
  // The part chosen last: a new word opens there.
  const [current, setCurrent] = useState<Part>(() => (readPref('lexicalTab') as Part | null) ?? 'define')
  const chosen = useRef<Part>(current)
  const [status, setStatus] = useState<DictionaryStatus | null>(null)
  const [entries, setEntries] = useState<DictionaryEntry[] | null>(null)
  const [lookupError, setLookupError] = useState<string | null>(null)
  const [lexicon, setLexicon] = useState<LexiconEntry[]>([])
  const [history, setHistory] = useState<string[]>([])
  const [browsing, setBrowsing] = useState(false)
  const body = useRef<HTMLDivElement>(null)
  const word = query?.word ?? null

  const refreshLexicon = useCallback(() => window.verdandi.lexicon.list().then(setLexicon, () => setLexicon([])), [])

  useEffect(() => {
    void window.verdandi.dictionary.status().then(setStatus)
    void refreshLexicon()
  }, [refreshLexicon])

  useEffect(() => {
    if (!word || !status?.available) return
    let active = true
    window.verdandi.dictionary.lookup(word).then(
      (result) => {
        if (!active) return
        setEntries(result)
        setLookupError(null)
      },
      (error: unknown) => {
        if (!active) return
        setEntries(null)
        setLookupError(errorMessage(error))
      },
    )
    return () => {
      active = false
    }
  }, [word, status])

  const partTop = (part: Part) => {
    const container = body.current
    const element = container?.querySelector<HTMLElement>(`[data-part="${part}"]`)
    return container && element ? element.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop : null
  }
  const scrollTo = useCallback((part: Part) => {
    const container = body.current
    const top = partTop(part)
    // The first part from the very top; the others with their title at the top.
    if (container && top !== null) container.scrollTop = part === PARTS[0].id ? 0 : top
  }, [])
  const choose = (part: Part) => {
    chosen.current = part
    setCurrent(part)
    writePref('lexicalTab', part)
    scrollTo(part)
  }

  // A new word's parts open at the one chosen last, once its entries are there.
  const shownWord = word && entries ? `${word}|${entries.length}|${entries[0]?.id ?? ''}` : word
  useLayoutEffect(() => {
    if (shownWord) scrollTo(chosen.current)
  }, [shownWord, scrollTo])

  // The tab of the part at the top of the column, as it scrolls; at the very end, the last part.
  const onScroll = () => {
    const container = body.current
    if (!container) return
    let at: Part = PARTS[0].id
    for (const part of PARTS) {
      const top = partTop(part.id)
      if (top !== null && top <= container.scrollTop + 12) at = part.id
    }
    if (container.scrollTop > 0 && container.scrollTop + container.clientHeight >= container.scrollHeight - 2) at = PARTS[PARTS.length - 1].id
    setCurrent(at)
  }

  const lookUp = (next: string) => {
    if (word && next.toLocaleLowerCase() !== word.toLocaleLowerCase()) setHistory((items) => [...items.slice(-30), word])
    onLookup(next)
  }
  const back = () => {
    const previous = history.at(-1)
    if (!previous) return
    setHistory((items) => items.slice(0, -1))
    onLookup(previous)
  }

  const saved = useMemo(
    () => (word ? lexicon.find((entry) => entry.word.toLocaleLowerCase() === word.toLocaleLowerCase()) ?? null : null),
    [lexicon, word],
  )
  const ready = word !== null && status?.available === true && entries !== null

  return (
    <div className="lexical-panel" aria-label="Words">
      <header className="lexical-header">
        <button type="button" className="icon-button" onClick={back} disabled={history.length === 0} title="Back" aria-label="Back"><ArrowLeft size={14} aria-hidden="true" /></button>
        <SearchBox word={word} onLookup={lookUp} enabled={status?.available ?? false} />
        <button type="button" className="icon-button" onClick={() => setBrowsing(true)} title="Saved words: browse, search and add" aria-label="Saved words">
          <BookMarked size={14} aria-hidden="true" />
        </button>
      </header>
      <nav className="lexical-tabs" aria-label="Parts">
        {PARTS.map((part) => (
          <button key={part.id} type="button" aria-current={current === part.id ? 'true' : undefined} onClick={() => choose(part.id)}>
            {part.label}
          </button>
        ))}
      </nav>

      <div className="lexical-body lexical-column" ref={body} onScroll={onScroll}>
        {status && !status.available && (
          <div className="lexical-message">
            <p>{status.error}</p>
            <DictionaryDownloader onReady={setStatus} />
            <button type="button" className="link-button" onClick={() => void window.verdandi.dictionary.choose().then(setStatus)}>or choose an existing wiktionary.db…</button>
          </div>
        )}
        {!word && status?.available && <p className="lexical-message">Select a word, or press Ctrl+D with the cursor on one.</p>}
        {lookupError && <p className="lexical-message status-error">{lookupError}</p>}

        <section data-part="define" className="lexical-part">
          {ready ? <DefineTab word={word} entries={entries} saved={saved} /> : <PartTitle>Define</PartTitle>}
        </section>
        <section data-part="etymology" className="lexical-part">
          <PartTitle>Etymology</PartTitle>
          {ready && <EtymologyTab word={word} entries={entries} onLookup={lookUp} />}
        </section>
        <section data-part="thesaurus" className="lexical-part">
          <PartTitle>Thesaurus</PartTitle>
          {ready && <ThesaurusTab entries={entries} saved={saved} onLookup={lookUp} onReplace={onReplace} />}
        </section>
        <section data-part="lexicon" className="lexical-part">
          <PartTitle>Lexicon</PartTitle>
          <LexiconPart query={query} entries={entries} saved={saved} count={lexicon.length} onChanged={() => void refreshLexicon()} onBrowse={() => setBrowsing(true)} />
        </section>
        <section data-part="external" className="lexical-part lexical-part-last">
          <PartTitle>Web</PartTitle>
          {word ? (
            <ul className="lexical-links">
              {EXTERNAL_SITES.map((site) => (
                <li key={site.label}>
                  <button type="button" className="link-button" onClick={() => window.open(site.url(word), '_blank')}>
                    {site.label} ↗
                  </button>
                </li>
              ))}
            </ul>
          ) : <p className="lexical-message">Look up a word to open it on these sites.</p>}
        </section>
      </div>
      {browsing && (
        <LexiconPage lexicon={lexicon} initialWord={word} onChanged={() => void refreshLexicon()} onClose={() => setBrowsing(false)}
          onLookup={(next) => {
            setBrowsing(false)
            lookUp(next)
          }} />
      )}
    </div>
  )
}

function PartTitle({ children }: { children: ReactNode }) {
  return <h3 className="lexical-section-title">{children}</h3>
}

function SearchBox({ word, onLookup, enabled }: { word: string | null; onLookup: (word: string) => void; enabled: boolean }) {
  const [text, setText] = useState(word ?? '')
  const [shown, setShown] = useState(word)
  const [suggestions, setSuggestions] = useState<DictionarySearchResult[]>([])
  // Follow the looked-up word unless the user is typing a new one.
  if (word !== shown) {
    setShown(word)
    setText(word ?? '')
    setSuggestions([])
  }

  useEffect(() => {
    const trimmed = text.trim()
    if (!enabled || trimmed.length < 2 || trimmed === word) return
    let active = true
    const timer = window.setTimeout(() => {
      window.verdandi.dictionary.search(trimmed, 8).then((results) => { if (active) setSuggestions(results) }, () => {})
    }, 200)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [text, enabled, word])

  const submit = (value: string) => {
    setSuggestions([])
    if (value.trim()) onLookup(value.trim())
  }

  return (
    <div className="lexical-search">
      <input
        value={text}
        placeholder="Look up a word"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') submit(text)
          if (event.key === 'Escape') setSuggestions([])
        }}
        onBlur={() => window.setTimeout(() => setSuggestions([]), 150)}
      />
      {suggestions.length > 0 && (
        <ul className="lexical-suggestions">
          {suggestions.map((result) => (
            <li key={`${result.word}|${result.pos}`}>
              <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => submit(result.word)}>
                <strong>{result.word}</strong> <em>{result.pos}</em>
                <span>{result.gloss}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function DefineTab({ word, entries, saved }: { word: string; entries: DictionaryEntry[]; saved: LexiconEntry | null }) {
  const ipa = [...new Set(entries.flatMap((entry) => entry.ipa))].slice(0, 3)
  return (
    <div className="lexical-define">
      <h2 className="lexical-word">{entries[0]?.word ?? word}</h2>
      {ipa.length > 0 && <p className="lexical-ipa">{ipa.join(' · ')}</p>}
      {saved && <p className="lexical-saved" title={saved.definition}>In your lexicon{saved.tags.length ? ` · ${saved.tags.join(', ')}` : ''}</p>}
      {entries.length === 0 && <p className="lexical-message">No entry in the local Wiktionary.</p>}
      {entries.map((entry) => (
        <section key={entry.id} className="lexical-entry">
          <h3>{entry.pos ?? 'unclassified'}</h3>
          <ol>
            {entry.senses.filter((sense) => sense.glosses.length > 0).slice(0, 12).map((sense, index) => (
              <li key={index}>
                {sense.glosses.join('; ')}
                {sense.examples[0] && <blockquote>{sense.examples[0].text}</blockquote>}
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  )
}

function EtymologyTab({ word, entries, onLookup }: { word: string; entries: DictionaryEntry[]; onLookup: (word: string) => void }) {
  // Parts of speech often share one etymology; show each distinct text once.
  const texts = [...new Set(entries.map((entry) => entry.etymology).filter((text): text is string => Boolean(text)))]
  if (texts.length === 0) return <p className="lexical-message">No etymology recorded for “{word}”.</p>
  return (
    <div className="lexical-etymology">
      {texts.map((text, index) => {
        const etymology = parseEtymology(text, entries[0]?.word ?? word)
        return (
          <section key={index} className="lexical-entry">
            {texts.length > 1 && <h3>Etymology {index + 1}</h3>}
            {etymology.tree.length > 0 && (
              <ol className="etymology-tree">
                {etymology.tree.map((step, stepIndex) => (
                  <li key={stepIndex}>
                    <span className="etymology-language">{step.language}</span>
                    {step.language === 'English' ? (
                      <button type="button" className="link-button" onClick={() => onLookup(step.term)}>{step.term}</button>
                    ) : (
                      <button type="button" className="link-button" onClick={() => window.open(wiktionaryUrl(step.term, step.language), '_blank')}>
                        {step.term} ↗
                      </button>
                    )}
                  </li>
                ))}
              </ol>
            )}
            {etymology.prose && <p className="etymology-prose">{etymology.prose}</p>}
            {etymology.cognates && (
              <details>
                <summary>Cognates</summary>
                <p className="etymology-cognates">{etymology.cognates}</p>
              </details>
            )}
          </section>
        )
      })}
    </div>
  )
}

function ThesaurusTab({ entries, saved, onLookup, onReplace }: {
  entries: DictionaryEntry[]
  saved: LexiconEntry | null
  onLookup: (word: string) => void
  onReplace: (word: string) => boolean
}) {
  const [notice, setNotice] = useState<string | null>(null)
  const collect = (key: 'synonyms' | 'antonyms' | 'related' | 'derived') =>
    [...new Set(entries.flatMap((entry) => entry[key]))]
  // Only synonyms and antonyms are offered as replacements; related and derived words are for exploring.
  const groups: { label: string; words: string[]; replaceable: boolean }[] = [
    { label: 'Synonyms', words: [...new Set([...(saved?.synonyms ?? []), ...collect('synonyms')])], replaceable: true },
    { label: 'Antonyms', words: collect('antonyms'), replaceable: true },
    { label: 'Related', words: collect('related'), replaceable: false },
    { label: 'Derived', words: collect('derived').slice(0, 40), replaceable: false },
  ].filter((group) => group.words.length > 0)

  const replace = (word: string) => {
    setNotice(onReplace(word) ? null : 'Put the cursor on a word in the text first.')
  }

  if (groups.length === 0) return <p className="lexical-message">No related words recorded.</p>
  return (
    <div className="lexical-thesaurus">
      <p className="lexical-hint">Click to look up · on synonyms and antonyms, ↵ or Alt+click replaces the word in your text</p>
      {notice && <p className="lexical-message status-error">{notice}</p>}
      {groups.map((group) => (
        <section key={group.label} className="lexical-entry">
          <h3>{group.label}</h3>
          <div className="chips">
            {group.words.map((word) => (
              <span key={word} className="chip">
                <button type="button" onClick={(event) => (event.altKey && group.replaceable ? replace(word) : onLookup(word))}>{word}</button>
                {group.replaceable && (
                  <button type="button" className="chip-replace" title={`Replace with “${word}”`} onClick={() => replace(word)}>↵</button>
                )}
              </span>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

function LexiconPart({ query, entries, saved, count, onChanged, onBrowse }: {
  query: LexicalQuery | null
  entries: DictionaryEntry[] | null
  saved: LexiconEntry | null
  count: number
  onChanged: () => void
  onBrowse: () => void
}) {
  const [message, setMessage] = useState<string | null>(null)
  return (
    <div className="lexical-lexicon">
      {query ? (
        <LexiconForm key={`${query.word}|${saved?.added ?? ''}|${entries ? 'entries' : ''}`} word={query.word} context={query.context} source={query.source}
          entries={entries} saved={saved} onSaved={(text) => {
            setMessage(text)
            onChanged()
          }} />
      ) : <p className="lexical-message">Look up a word to save it.</p>}
      {message && <p className="lexical-message">{message}</p>}
      <button type="button" className="link-button" onClick={onBrowse}>
        {count ? `Browse your ${count.toLocaleString()} saved word${count === 1 ? '' : 's'}…` : 'Saved words…'}
      </button>
    </div>
  )
}
