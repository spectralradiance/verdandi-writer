import type { LineEnding, TextEncodingName } from './ipc'
import { classifyLines, type LayerNames } from './notes'

const WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu

export function countWords(text: string): number {
  return text.match(WORD)?.length ?? 0
}

const ENCODING_LABELS: Record<TextEncodingName, string> = {
  'utf-8': 'UTF-8',
  'utf-8-bom': 'UTF-8 BOM',
  'utf-16le': 'UTF-16 LE',
  'utf-16be': 'UTF-16 BE',
  'windows-1252': 'Windows-1252',
}

export function encodingLabel(encoding: TextEncodingName): string {
  return ENCODING_LABELS[encoding]
}

export function lineEndingLabel(eol: LineEnding): string {
  return eol === '\r\n' ? 'CRLF' : eol === '\r' ? 'CR' : 'LF'
}

export interface Heading {
  level: number
  text: string
  /** 1-based line number. */
  line: number
}

/** ATX headings outside fenced code blocks and notes blocks, for the outline. */
export function extractHeadings(text: string, layers?: LayerNames): Heading[] {
  const headings: Heading[] = []
  let fence: string | null = null
  const lines = text.split('\n')
  const roles = classifyLines(lines, layers)
  lines.forEach((line, index) => {
    if (roles[index] !== 'output') return
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1][0]
      else if (fenceMatch[1][0] === fence) fence = null
      return
    }
    if (fence !== null) return
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (heading && heading[2]) {
      const plain = heading[2].replace(/(\*\*|__|\*|_|`|~~)(.+?)\1/g, '$2').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      headings.push({ level: heading[1].length, text: plain, line: index + 1 })
    }
  })
  return headings
}

const WORD_AT = /[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*/gu

/** The word touching `offset` in `line`, if any. */
export function wordAt(line: string, offset: number): { word: string; from: number; to: number } | null {
  for (const match of line.matchAll(WORD_AT)) {
    const from = match.index
    const to = from + match[0].length
    if (offset >= from && offset <= to) return { word: match[0], from, to }
  }
  return null
}

/** Whether `text` is a single word (possibly with an apostrophe or hyphen). */
export function isSingleWord(text: string): boolean {
  return /^[\p{L}\p{M}]+(?:['’-][\p{L}\p{M}]+)*$/u.test(text)
}

/** The sentence around [from, to) within a paragraph, trimmed of Markdown markers. */
export function sentenceAround(paragraph: string, from: number, to: number): string {
  const before = paragraph.slice(0, from)
  const after = paragraph.slice(to)
  const start = Math.max(before.lastIndexOf('. '), before.lastIndexOf('! '), before.lastIndexOf('? ')) + 1
  const endMatch = /[.!?](\s|$)/.exec(after)
  const end = endMatch ? to + endMatch.index + 1 : paragraph.length
  return paragraph.slice(start, end).replace(/^[\s>#*-]+/, '').replace(/[*_`]+/g, '').trim()
}

/** Gives `replacement` the capitalization pattern of `original` (Word → Word, WORD → WORD). */
export function matchCase(original: string, replacement: string): string {
  if (original.length > 1 && original === original.toLocaleUpperCase()) return replacement.toLocaleUpperCase()
  const first = original.charAt(0)
  if (first && first === first.toLocaleUpperCase() && first !== first.toLocaleLowerCase()) {
    return replacement.charAt(0).toLocaleUpperCase() + replacement.slice(1)
  }
  return replacement
}

/** `<!-- section: Name -->`: starts a section that has a name but no heading. */
const SECTION_MARKER = /^[ \t]{0,3}<!--[ \t]*section:[ \t]*(.*?)[ \t]*-->[ \t]*$/i

/**
 * A marker's attributes, after its name: `{#7f3a .heading}`. Only a folder document,
 * shown to the editor as one text, writes them: the id says which section file the
 * section is, and `.heading` that exports show its name as a heading.
 */
const MARKER_ATTRIBUTES = /^(.*?)[ \t]*\{((?:[ \t]*[#.][A-Za-z0-9_-]+)+)[ \t]*\}$/

export interface SectionMarker {
  name: string
  /** The section file's id, in a folder document. */
  id: string | null
  /** Exports show the name as a heading (a folder document's `.heading`). */
  heading: boolean
  /** 1-based line number. */
  line: number
}

/** A marker line's name and attributes, or null if the line is not one. */
export function parseMarker(line: string): Omit<SectionMarker, 'line'> | null {
  const match = SECTION_MARKER.exec(line.replace(/\r$/, ''))
  if (!match) return null
  const attributes = MARKER_ATTRIBUTES.exec(match[1])
  if (!attributes) return { name: match[1], id: null, heading: false }
  const parts = attributes[2].trim().split(/\s+/)
  const id = parts.find((part) => part.startsWith('#'))?.slice(1) ?? null
  return { name: attributes[1], id, heading: parts.includes('.heading') }
}

/** The name in a section marker line, or null if the line is not one. */
export function parseSectionMarker(line: string): string | null {
  return parseMarker(line)?.name ?? null
}

/** The marker line for a section called `name` (an HTML comment, so it never shows in exports). */
export function sectionMarkerLine(name: string, attributes: { id?: string | null; heading?: boolean } = {}): string {
  const clean = name.replace(/\s+/g, ' ').replace(/--+/g, '–').replace(/[{}]/g, '').trim()
  const parts = [attributes.id ? `#${attributes.id}` : '', attributes.heading ? '.heading' : ''].filter(Boolean)
  return `<!-- section: ${clean}${parts.length ? ` {${parts.join(' ')}}` : ''} -->`
}

/** Section markers outside fenced code blocks and layer blocks. */
export function extractSectionMarkers(text: string, layers?: LayerNames): SectionMarker[] {
  const markers: SectionMarker[] = []
  let fence: string | null = null
  const lines = text.split('\n')
  const roles = classifyLines(lines, layers)
  lines.forEach((line, index) => {
    if (roles[index] !== 'output') return
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1][0]
      else if (fenceMatch[1][0] === fence) fence = null
      return
    }
    if (fence !== null) return
    const marker = parseMarker(line)
    if (marker !== null) markers.push({ ...marker, line: index + 1 })
  })
  return markers
}

/**
 * Whether the text is a folder document shown as one text: its markers carry
 * section ids. Then only markers start sections, and headings are just text.
 */
export function splitsAtMarkersOnly(markers: readonly Pick<SectionMarker, 'id'>[]): boolean {
  return markers.some((marker) => marker.id !== null)
}

/** Removes section marker lines (for exporting the text). */
export function stripSectionMarkers(text: string, layers?: LayerNames): string {
  const drop = new Set(extractSectionMarkers(text, layers).map((marker) => marker.line - 1))
  if (drop.size === 0) return text
  // A marker becomes a blank line rather than nothing, so the sections either side of it never run into one paragraph.
  const lines = text.split('\n').map((line, index) => (drop.has(index) ? '' : line))
  if (drop.has(0)) lines.shift()
  return lines.join('\n').replace(/\n{3,}/g, '\n\n')
}
