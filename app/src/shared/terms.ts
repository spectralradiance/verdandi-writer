// Term tracking (the Statistics dialog's Terms tab): where each of a document's
// terms is used, section by section; where it is first used and where it is
// defined (its first emphasized or quoted use, the way a text introduces a term);
// and whether it is used before it is defined.

import { STOPWORDS } from './readability'

export interface TermSection {
  title: string
  line: number
  text: string
}

export interface TermUse {
  term: string
  /** Uses in each section, in order. */
  counts: number[]
  total: number
  /** Sections it is used in. */
  sections: number
  /** The first section it is used in, and the first where it is emphasized or quoted (by index), or null. */
  first: number | null
  defined: number | null
  /** Used in an earlier section than the one that defines it. */
  beforeDefinition: boolean
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A term as a pattern: whole words, any case, with a plural `s` or `es`; spaces match any run of spaces. */
function termPattern(term: string): RegExp {
  const words = term.trim().split(/\s+/).map(escape).join('\\s+')
  return new RegExp(`(?<![\\p{L}\\p{N}])${words}(?:e?s)?(?![\\p{L}\\p{N}])`, 'giu')
}

/** Emphasis or quotes right around a use: `**term**`, `*term*`, `_term_`, “term”, "term". */
const EMPHASIS_BEFORE = /(\*\*|\*|__|_|[“"'‘])$/
const EMPHASIS_AFTER = /^(\*\*|\*|__|_|[”"'’])/

/** Where each term is used across the sections. */
export function trackTerms(sections: readonly TermSection[], terms: readonly string[]): TermUse[] {
  return terms.filter((term) => term.trim()).map((term) => {
    const pattern = termPattern(term)
    let defined: number | null = null
    const counts = sections.map((section, index) => {
      let count = 0
      for (const match of section.text.matchAll(pattern)) {
        count += 1
        if (defined === null) {
          const before = section.text.slice(Math.max(0, match.index - 2), match.index)
          const after = section.text.slice(match.index + match[0].length, match.index + match[0].length + 2)
          if (EMPHASIS_BEFORE.test(before) && EMPHASIS_AFTER.test(after)) defined = index
        }
      }
      return count
    })
    const first = counts.findIndex((count) => count > 0)
    return {
      term: term.trim(),
      counts,
      total: counts.reduce((sum, count) => sum + count, 0),
      sections: counts.filter((count) => count > 0).length,
      first: first < 0 ? null : first,
      defined,
      beforeDefinition: defined !== null && first >= 0 && first < defined,
    }
  })
}

const PHRASE = /^[\p{L}][\p{L}\p{N}'’-]*(?:\s+[\p{L}][\p{L}\p{N}'’-]*){0,3}$/u

/**
 * Terms a text seems to introduce, most used first: what it puts in bold, italics
 * or quotes (one to four words), and capitalized words used mid-sentence at least
 * three times. Words in `known` (already tracked) are left out.
 */
export function suggestTerms(text: string, known: readonly string[] = [], limit = 30): string[] {
  const taken = new Set(known.map((term) => term.toLowerCase()))
  const counts = new Map<string, { term: string; count: number }>()
  const add = (raw: string, weight = 1) => {
    const term = raw.trim().replace(/[.,;:!?]+$/, '')
    const key = term.toLowerCase()
    if (!PHRASE.test(term) || taken.has(key) || (!term.includes(' ') && (STOPWORDS.has(key) || key.length < 3))) return
    const entry = counts.get(key) ?? { term, count: 0 }
    entry.count += weight
    counts.set(key, entry)
  }
  for (const match of text.matchAll(/\*\*([^*\n]+)\*\*|__([^_\n]+)__|(?<![*\w])\*([^*\n]+)\*(?!\*)|(?<![\w_])_([^_\n]+)_(?![\w_])/g)) {
    add(match[1] ?? match[2] ?? match[3] ?? match[4], 3)
  }
  // Quoted, as a term rather than speech: mid-sentence (after a lowercase word), up to three
  // words, with no punctuation of its own ("the so-called “reflexion” is", not “Go home,” she said).
  for (const match of text.matchAll(/(?<=\p{Ll} )[“"‘]([^”"’\n.,;:!?]{2,40})[”"’]/gu)) {
    if (match[1].trim().split(/\s+/).length <= 3) add(match[1], 2)
  }
  // Capitalized mid-sentence: after a lowercase word and a space, so not a sentence's first word.
  const capitals = new Map<string, number>()
  for (const match of text.matchAll(/(?<=[\p{Ll},;:] )(\p{Lu}[\p{Ll}'’-]{2,})/gu)) capitals.set(match[1], (capitals.get(match[1]) ?? 0) + 1)
  for (const [word, count] of capitals) if (count >= 3) add(word, count)
  return [...counts.values()]
    .filter((entry) => entry.count >= 3)
    .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term))
    .slice(0, limit)
    .map((entry) => entry.term)
}

/**
 * Where each saved word is used, like `trackTerms` but quick for a long list: each
 * section's words are counted once, and one-word entries are looked up in the
 * counts (with a plural `s` or `es`). Only words used at all are returned, most used
 * first. A saved word's definition is not looked for, so `defined` is null.
 */
export function trackSavedWords(sections: readonly TermSection[], words: readonly string[]): TermUse[] {
  const counted = sections.map((section) => {
    const counts = new Map<string, number>()
    for (const match of section.text.toLocaleLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) counts.set(match[0], (counts.get(match[0]) ?? 0) + 1)
    return counts
  })
  const single = words.filter((word) => /^[\p{L}\p{N}]+$/u.test(word.trim()))
  const several = words.filter((word) => word.trim() && !/^[\p{L}\p{N}]+$/u.test(word.trim()))
  const uses: TermUse[] = single.map((raw) => {
    const word = raw.trim()
    const key = word.toLocaleLowerCase()
    const counts = counted.map((map) => (map.get(key) ?? 0) + (map.get(`${key}s`) ?? 0) + (map.get(`${key}es`) ?? 0))
    const first = counts.findIndex((count) => count > 0)
    return {
      term: word,
      counts,
      total: counts.reduce((sum, count) => sum + count, 0),
      sections: counts.filter((count) => count > 0).length,
      first: first < 0 ? null : first,
      defined: null,
      beforeDefinition: false,
    }
  })
  uses.push(...trackTerms(sections, several).map((use) => ({ ...use, defined: null, beforeDefinition: false })))
  return uses.filter((use) => use.total > 0).sort((a, b) => b.total - a.total || a.term.localeCompare(b.term))
}
