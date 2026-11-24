// Draft-to-draft comparison (the Statistics dialog's Compare tab): one layer of a
// document against another, section by section. The texts are compared sentence
// by sentence, which keeps a whole book quick to compare and reads as "this
// sentence was cut, this one added" rather than as scattered words.

import { splitSections } from './document'
import { layerText } from './layerStats'
import type { LayerNames } from './notes'
import { countWords } from './text'

export type SentenceChange = { kind: 'same' | 'added' | 'removed'; text: string }

export interface SectionComparison {
  title: string
  line: number
  /** Words in the layer compared from, and in the layer compared to. */
  before: number
  after: number
  /** Words in sentences only `after` has, only `before` has, and both have. */
  added: number
  removed: number
  kept: number
  /** How much of the two the sentences they share make up, 0–100. */
  similarity: number
}

export interface LayerComparison {
  sections: SectionComparison[]
  before: number
  after: number
  added: number
  removed: number
  kept: number
  /** Sections with something in `after` only, or in `before` only. */
  newSections: number
  emptiedSections: number
  /** Sections whose sentences differ at all. */
  changedSections: number
}

/** A text's sentences, paragraph by paragraph: whitespace evened out, Markdown left as it is. */
export function splitSentences(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .flatMap((paragraph) => paragraph.replace(/\s+/g, ' ').trim().split(/(?<=[.!?…]["”’)\]]*)\s+(?=["“‘([]?[\p{Lu}\p{N}])/u))
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== '')
}

/** Past this many sentence pairs a section is compared as a whole, not sentence by sentence. */
const MAX_CELLS = 4_000_000

/** The sentences of `before` and `after` in order, each kept, added or removed. */
export function compareSentences(before: string, after: string): SentenceChange[] {
  const a = splitSentences(before)
  const b = splitSentences(after)
  if (a.length * b.length > MAX_CELLS) {
    return [...a.map((text) => ({ kind: 'removed' as const, text })), ...b.map((text) => ({ kind: 'added' as const, text }))]
  }
  // Longest common subsequence of sentences, from the end, so the walk below goes forwards.
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  }
  const changes: SentenceChange[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      changes.push({ kind: 'same', text: a[i] })
      i += 1
      j += 1
    } else if (j >= b.length || (i < a.length && lcs[i + 1][j] >= lcs[i][j + 1])) {
      changes.push({ kind: 'removed', text: a[i] })
      i += 1
    } else {
      changes.push({ kind: 'added', text: b[j] })
      j += 1
    }
  }
  return changes
}

/** Words added, removed and kept between two texts. */
export function changeCounts(changes: readonly SentenceChange[]): { added: number; removed: number; kept: number } {
  let added = 0
  let removed = 0
  let kept = 0
  for (const change of changes) {
    const words = countWords(change.text)
    if (change.kind === 'added') added += words
    else if (change.kind === 'removed') removed += words
    else kept += words
  }
  return { added, removed, kept }
}

const similarityOf = (kept: number, added: number, removed: number) => {
  const total = kept * 2 + added + removed
  return total === 0 ? 100 : Math.round(((kept * 2) / total) * 100)
}

/** Layer `from` against layer `to`, section by section (titled sections only). */
export function compareLayers(text: string, names: LayerNames, from: string, to: string): LayerComparison {
  const sections: SectionComparison[] = []
  for (const section of splitSections(text, names)) {
    if (section.title === null) continue
    const before = layerText(section, from, names)
    const after = layerText(section, to, names)
    const counts = before === after ? { added: 0, removed: 0, kept: countWords(before) } : changeCounts(compareSentences(before, after))
    sections.push({
      title: section.title,
      line: section.line,
      before: counts.removed + counts.kept,
      after: counts.added + counts.kept,
      ...counts,
      similarity: similarityOf(counts.kept, counts.added, counts.removed),
    })
  }
  const sum = (key: 'before' | 'after' | 'added' | 'removed' | 'kept') => sections.reduce((total, section) => total + section[key], 0)
  return {
    sections,
    before: sum('before'),
    after: sum('after'),
    added: sum('added'),
    removed: sum('removed'),
    kept: sum('kept'),
    newSections: sections.filter((section) => section.before === 0 && section.after > 0).length,
    emptiedSections: sections.filter((section) => section.before > 0 && section.after === 0).length,
    changedSections: sections.filter((section) => section.added > 0 || section.removed > 0).length,
  }
}
