// Vocabulary and grammar measures for one section's text, computed locally and kept
// per day so a writer can see how a section's style changes as it is revised.
// Heuristics, not parsing: passive voice and adverbs are estimates from word shapes,
// good enough to show a trend.

import { measureText, plainText, STOPWORDS, syllables, type TextMetrics } from './readability'

export interface StyleMetrics extends TextMetrics {
  /** Different words used (case ignored). */
  distinctWords: number
  /**
   * Vocabulary variety, 0–100: the share of different words in every run of 50 words,
   * averaged (moving-average type–token ratio), so it doesn't fall as a text grows.
   */
  variety: number
  /** Average letters per word. */
  wordLength: number
  /** Share of words of three syllables or more, in percent. */
  longWords: number
  /** Share of content words (not "the", "of", "was"…), in percent. */
  density: number
  /** Share of sentences that look passive ("was taken", "were seen"), in percent. */
  passive: number
  /** Adverbs ending in -ly, per 100 words. */
  adverbs: number
  /** Filler and hedge words ("just", "really", "very"…), per 100 words. */
  fillers: number
  /** Share of sentences that are questions, in percent. */
  questions: number
  /** Share of words inside quotation marks, in percent. */
  dialogue: number
}

/** The measures a section's history keeps, in the order they are shown. */
export const TRACKED: readonly { key: keyof StyleMetrics; label: string; unit: string; hint: string }[] = [
  { key: 'words', label: 'Words', unit: '', hint: 'Words in the text' },
  { key: 'variety', label: 'Vocabulary variety', unit: '', hint: 'Different words in every run of 50, out of 100. Higher is more varied.' },
  { key: 'distinctWords', label: 'Different words', unit: '', hint: 'Different words used, ignoring case' },
  { key: 'wordLength', label: 'Word length', unit: ' letters', hint: 'Average letters per word' },
  { key: 'longWords', label: 'Long words', unit: '%', hint: 'Words of three syllables or more' },
  { key: 'density', label: 'Lexical density', unit: '%', hint: 'Content words, as against “the”, “of”, “was” and the like' },
  { key: 'averageSentenceWords', label: 'Sentence length', unit: ' words', hint: 'Average words per sentence' },
  { key: 'sentenceSpread', label: 'Sentence rhythm', unit: '', hint: 'How much sentence lengths vary. Low reads as monotonous.' },
  { key: 'passive', label: 'Passive voice', unit: '%', hint: 'Sentences that look passive (“was taken”). An estimate.' },
  { key: 'adverbs', label: '-ly adverbs', unit: ' /100', hint: 'Words ending in -ly, per 100 words' },
  { key: 'fillers', label: 'Fillers', unit: ' /100', hint: '“just”, “really”, “very”, “quite”… per 100 words' },
  { key: 'questions', label: 'Questions', unit: '%', hint: 'Sentences ending in a question mark' },
  { key: 'dialogue', label: 'Dialogue', unit: '%', hint: 'Words inside quotation marks' },
  { key: 'readingEase', label: 'Reading ease', unit: '', hint: 'Flesch reading ease: 60–70 is plain English; higher is easier' },
]

const WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu
const WINDOW = 50
const FILLERS = new Set(['just', 'really', 'very', 'quite', 'rather', 'somewhat', 'actually', 'basically', 'simply', 'literally', 'perhaps', 'maybe', 'seemed', 'seems', 'almost', 'slightly'])
// -ly words that aren't adverbs.
const NOT_ADVERBS = new Set(['only', 'family', 'early', 'holy', 'lonely', 'lovely', 'ugly', 'silly', 'belly', 'fly', 'july', 'italy', 'reply', 'supply', 'apply', 'rely', 'ally', 'jelly', 'bully', 'rally', 'hilly', 'chilly', 'friendly', 'likely', 'daily', 'weekly', 'monthly', 'yearly', 'elderly', 'curly', 'oily', 'woolly', 'smelly', 'kindly', 'lily', 'emily', 'sally', 'molly', 'polly', 'anomaly', 'assembly', 'butterfly', 'dragonfly', 'monopoly', 'melancholy'])
const BE = /\b(?:am|is|are|was|were|be|been|being)\b(?:\s+(?:not|never|also|then|still|all|already|just|being))*\s+(\p{L}+)/giu
const IRREGULAR_PARTICIPLES = new Set(['taken', 'given', 'seen', 'known', 'shown', 'written', 'driven', 'broken', 'chosen', 'spoken', 'stolen', 'forgotten', 'hidden', 'built', 'bought', 'brought', 'caught', 'taught', 'thought', 'found', 'held', 'kept', 'left', 'lost', 'made', 'meant', 'paid', 'said', 'sent', 'sold', 'told', 'won', 'done', 'gone', 'born', 'worn', 'torn', 'drawn', 'thrown', 'grown', 'blown', 'sung', 'hung', 'struck', 'shut', 'put', 'set', 'cut', 'hit', 'hurt', 'beaten', 'bitten', 'eaten', 'fallen', 'frozen', 'shaken', 'woken', 'ridden', 'risen', 'sworn', 'buried', 'carried', 'lit', 'led', 'fed', 'read', 'heard', 'laid'])
// Words ending in -ed that read as adjectives after "was": "was tired" says how she was, not what was done to her.
const NOT_PARTICIPLES = new Set([
  'red', 'bed', 'shed', 'sacred', 'naked', 'wicked', 'rugged', 'ragged', 'hundred', 'kindred',
  'tired', 'scared', 'worried', 'excited', 'interested', 'bored', 'surprised', 'pleased', 'delighted', 'frightened',
  'confused', 'ashamed', 'annoyed', 'amazed', 'disappointed', 'satisfied', 'relieved', 'used', 'supposed', 'prepared',
  'determined', 'convinced', 'concerned', 'involved', 'exhausted', 'embarrassed', 'tempted', 'aged',
])

const round = (value: number, places = 1) => Math.round(value * 10 ** places) / 10 ** places
const percent = (part: number, whole: number) => (whole === 0 ? 0 : round((part / whole) * 100))

/** The share of different words in each window of 50, averaged (the whole text when it is shorter). */
function movingVariety(words: readonly string[]): number {
  if (words.length === 0) return 0
  if (words.length <= WINDOW) return round((new Set(words).size / words.length) * 100)
  const counts = new Map<string, number>()
  for (const word of words.slice(0, WINDOW)) counts.set(word, (counts.get(word) ?? 0) + 1)
  let total = counts.size
  for (let end = WINDOW; end < words.length; end += 1) {
    const out = words[end - WINDOW]
    const left = (counts.get(out) ?? 0) - 1
    if (left === 0) counts.delete(out)
    else counts.set(out, left)
    counts.set(words[end], (counts.get(words[end]) ?? 0) + 1)
    total += counts.size
  }
  return round((total / (words.length - WINDOW + 1) / WINDOW) * 100)
}

function looksPassive(sentence: string): boolean {
  for (const match of sentence.matchAll(BE)) {
    const word = match[1].toLowerCase()
    if (IRREGULAR_PARTICIPLES.has(word)) return true
    if (word.length > 3 && word.endsWith('ed') && !NOT_PARTICIPLES.has(word)) return true
  }
  return false
}

/** Words inside “curly” or "straight" double quotes. */
function quotedWords(text: string): number {
  let count = 0
  for (const match of text.matchAll(/[“"]([^”"\n]*)[”"]/g)) count += match[1].match(WORD)?.length ?? 0
  return count
}

export function analyzeStyle(markdown: string): StyleMetrics {
  const base = measureText(markdown)
  const text = plainText(markdown)
  const words = (text.match(WORD) ?? []).map((word) => word.toLocaleLowerCase())
  const sentences = text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])["”’)]*\s+/))
    .map((sentence) => sentence.trim())
    .filter((sentence) => /[\p{L}\p{N}]/u.test(sentence))
  const letters = words.reduce((sum, word) => sum + word.replace(/['’-]/g, '').length, 0)
  const total = words.length
  return {
    ...base,
    distinctWords: new Set(words).size,
    variety: movingVariety(words),
    wordLength: total === 0 ? 0 : round(letters / total),
    longWords: percent(words.filter((word) => syllables(word) >= 3).length, total),
    density: percent(words.filter((word) => !STOPWORDS.has(word)).length, total),
    passive: percent(sentences.filter(looksPassive).length, sentences.length),
    adverbs: total === 0 ? 0 : round((words.filter((word) => word.length > 4 && word.endsWith('ly') && !NOT_ADVERBS.has(word)).length / total) * 100),
    fillers: total === 0 ? 0 : round((words.filter((word) => FILLERS.has(word)).length / total) * 100),
    questions: percent(sentences.filter((sentence) => /\?["”’)]*$/.test(sentence)).length, sentences.length),
    dialogue: percent(quotedWords(text), total),
  }
}

/** One day's measures of a section, as kept in its history. */
export interface StylePoint {
  day: string
  values: Partial<Record<keyof StyleMetrics, number>>
}

/** The tracked measures of a section, for its history. */
export function trackedValues(metrics: StyleMetrics): StylePoint['values'] {
  const values: StylePoint['values'] = {}
  for (const { key } of TRACKED) values[key] = metrics[key] as number
  return values
}
