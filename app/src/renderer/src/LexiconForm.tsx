import { useEffect, useState } from 'react'

import type { DictionaryEntry, LexiconEntry } from '../../shared/ipc'
import { splitList } from '../../shared/lexicon'
import { errorMessage } from './target'

interface LexiconFormProps {
  /** The word, as looked up or typed; for a new word with `editableWord`, where the field starts. */
  word: string
  /** The sentence the word came from, and the file. */
  context: string
  source: string | null
  /** The dictionary's entries for the word, for a first definition. */
  entries: DictionaryEntry[] | null
  saved: LexiconEntry | null
  /** A new word typed in (the saved-words page), not one looked up. */
  editableWord?: boolean
  /** After saving or removing: what happened, and the word saved (null when removed or failed). */
  onSaved: (message: string, word: string | null) => void
}

/** Fills in a definition from the dictionary, unless one was typed meanwhile. */
function lookupGloss(word: string, setDefinition: (update: (current: string) => string) => void) {
  window.verdandi.dictionary.lookup(word).then((found) => {
    const gloss = firstGloss(found)
    if (gloss) setDefinition((current) => current || gloss)
  }, () => {})
}

export const firstGloss = (entries: DictionaryEntry[] | null) => entries?.flatMap((entry) => entry.senses.flatMap((sense) => sense.glosses))[0] ?? ''

/** Saves a word to the lexicon, or updates or removes a saved one. */
export function LexiconForm({ word: initialWord, context: initialContext, source, entries, saved, editableWord = false, onSaved }: LexiconFormProps) {
  const [word, setWord] = useState(saved?.word ?? initialWord)
  const [definition, setDefinition] = useState(saved?.definition ?? firstGloss(entries))
  const [tags, setTags] = useState(saved?.tags.join(', ') ?? '')
  const [synonyms, setSynonyms] = useState(saved?.synonyms.join(', ') ?? '')
  const [context, setContext] = useState(saved?.context || initialContext)
  const [note, setNote] = useState(saved?.note ?? '')
  const [busy, setBusy] = useState(false)

  // A new word's definition, from the dictionary once the word is typed (if there is nothing yet).
  const fillDefinition = (typed = word.trim()) => {
    if (!editableWord || !typed || definition.trim()) return
    lookupGloss(typed, setDefinition)
  }
  // A new word that comes with its spelling (typed in the search) gets its definition at once.
  useEffect(() => {
    if (editableWord && !saved && initialWord.trim()) lookupGloss(initialWord.trim(), setDefinition)
  }, [editableWord, saved, initialWord])

  const save = () => {
    const name = (saved?.word ?? (editableWord ? word : entries?.[0]?.word ?? word)).trim()
    if (!name) return
    setBusy(true)
    window.verdandi.lexicon.save({
      word: name,
      definition,
      tags: splitList(tags),
      synonyms: splitList(synonyms),
      context,
      source: saved?.source ?? source,
      added: saved?.added ?? '',
      note,
    }).then(
      (entry) => onSaved(saved ? `Updated “${entry.word}”.` : `Saved “${entry.word}” to your lexicon.`, entry.word),
      (error: unknown) => onSaved(errorMessage(error), null),
    ).finally(() => setBusy(false))
  }

  const remove = () => {
    if (!saved || !window.confirm(`Move “${saved.word}” to the Recycle Bin?`)) return
    window.verdandi.lexicon.remove(saved.word).then(() => onSaved(`Removed “${saved.word}”.`, null), (error: unknown) => onSaved(errorMessage(error), null))
  }

  return (
    <form className="lexicon-form" onSubmit={(event) => { event.preventDefault(); save() }}>
      {editableWord && !saved
        ? <label>Word<input value={word} autoFocus onChange={(event) => setWord(event.target.value)} onBlur={() => fillDefinition()} /></label>
        : <h2 className="lexical-word">{saved?.word ?? word}</h2>}
      <label>Definition<textarea rows={2} value={definition} onChange={(event) => setDefinition(event.target.value)} /></label>
      <label>Tags<input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="emotion, cosmology" /></label>
      <label>Synonyms<input value={synonyms} onChange={(event) => setSynonyms(event.target.value)} /></label>
      <label>Context<textarea rows={2} value={context} onChange={(event) => setContext(event.target.value)} /></label>
      <label>Note<textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} /></label>
      <div className="lexicon-actions">
        <button type="submit" disabled={busy || !word.trim()}>{saved ? 'Update' : 'Save word'}</button>
        {saved && <button type="button" onClick={remove}>Remove</button>}
      </div>
    </form>
  )
}
