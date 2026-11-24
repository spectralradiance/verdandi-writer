// Statistics for one layer of a document (the Statistics dialog): its counts per
// section, and its vocabulary and grammar measures. Worked out in the window from
// the document's text, so any layer can be looked at, not only the text itself.

import { analyzeStyle } from './analysis'
import { type DocSection, splitSections } from './document'
import type { SectionStyle, StyleReport } from './ipc'
import type { LayerNames } from './notes'

/** Sections shorter than this aren't measured (as in main/styleHistory.ts). */
const MIN_WORDS = 20
/** Words a minute, read silently and read aloud. */
const READING_WPM = 238
const SPEAKING_WPM = 150

/** A section's content in `layer`: `output` is the text itself, and a one-file document's only layer is its notes. */
export function layerText(section: DocSection, layer: string, names: LayerNames): string {
  if (layer === 'output') return section.output
  return names ? (section.layers[layer] ?? '') : section.notes
}

function layerWords(section: DocSection, layer: string, names: LayerNames): number {
  if (layer === 'output') return section.outputWords
  return names ? (section.layerWords[layer] ?? 0) : section.notesWords
}

export interface LayerSectionCount {
  title: string | null
  line: number
  words: number
  characters: number
  paragraphs: number
}

export interface LayerOverview {
  layer: string
  words: number
  /** Characters, spaces included. */
  characters: number
  paragraphs: number
  /** Sections, not counting what comes before the first. */
  sections: number
  /** Sections with something in the layer. */
  filled: number
  /** Minutes to read silently, and aloud. */
  readingMinutes: number
  speakingMinutes: number
  /** The section with the most words in the layer, if any has some. */
  longest: LayerSectionCount | null
  /** Each section's counts, in order (with what comes before the first, when it has any). */
  rows: LayerSectionCount[]
}

const paragraphsIn = (text: string) => text.split(/\n\s*\n/).filter((block) => /[\p{L}\p{N}]/u.test(block)).length

/** The counts of one layer of a document, as a whole and per section. */
export function layerOverview(text: string, names: LayerNames, layer: string): LayerOverview {
  const rows: LayerSectionCount[] = []
  for (const section of splitSections(text, names)) {
    const content = layerText(section, layer, names)
    if (section.title === null && !content.trim()) continue
    rows.push({ title: section.title, line: section.line, words: layerWords(section, layer, names), characters: content.length, paragraphs: paragraphsIn(content) })
  }
  const titled = rows.filter((row) => row.title !== null)
  const words = rows.reduce((sum, row) => sum + row.words, 0)
  const longest = titled.reduce<LayerSectionCount | null>((best, row) => (row.words > (best?.words ?? 0) ? row : best), null)
  return {
    layer,
    words,
    characters: rows.reduce((sum, row) => sum + row.characters, 0),
    paragraphs: rows.reduce((sum, row) => sum + row.paragraphs, 0),
    sections: titled.length,
    filled: titled.filter((row) => row.words > 0).length,
    readingMinutes: words / READING_WPM,
    speakingMinutes: words / SPEAKING_WPM,
    longest,
    rows,
  }
}

/** Every layer's words per section, for comparing layers (drafts, say) side by side. */
export function layerTable(text: string, names: LayerNames, layers: readonly string[]): { title: string; line: number; words: Record<string, number> }[] {
  return splitSections(text, names).filter((section) => section.title !== null).map((section) => ({
    title: section.title!,
    line: section.line,
    words: Object.fromEntries(layers.map((layer) => [layer, layerWords(section, layer, names)])),
  }))
}

/**
 * Vocabulary and grammar for one layer, measured now (the history the main process
 * keeps is of the text alone): each section, and the whole layer.
 */
export function layerStyleReport(text: string, names: LayerNames, layer: string): StyleReport {
  const sections = splitSections(text, names).filter((section) => section.title !== null)
  const measure = (key: string, title: string, line: number, content: string): SectionStyle => {
    const metrics = analyzeStyle(content)
    return { key, title, line, measured: metrics.words >= MIN_WORDS, metrics, history: [] }
  }
  return {
    sections: sections.map((section, index) => measure(`${index}:${section.title}`, section.title!, section.line, layerText(section, layer, names))),
    document: measure('*', 'Whole document', 1, sections.map((section) => layerText(section, layer, names)).filter((content) => content.trim()).join('\n\n')),
  }
}

/** `4 min`, `2 h 5 min`. */
export function formatMinutes(minutes: number): string {
  const rounded = Math.max(1, Math.round(minutes))
  if (rounded < 60) return `${rounded} min`
  const hours = Math.floor(rounded / 60)
  const rest = rounded % 60
  return rest ? `${hours} h ${rest} min` : `${hours} h`
}
