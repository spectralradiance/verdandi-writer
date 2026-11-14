import type { LineEnding, TextEncodingName } from './ipc'
import { classifyLines } from './notes'

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
export function extractHeadings(text: string): Heading[] {
  const headings: Heading[] = []
  let fence: string | null = null
  const lines = text.split('\n')
  const roles = classifyLines(lines)
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

export interface SectionMarker {
  name: string
  /** 1-based line number. */
  line: number
}

/** The name in a section marker line, or null if the line is not one. */
export function parseSectionMarker(line: string): string | null {
  const match = SECTION_MARKER.exec(line.replace(/\r$/, ''))
  return match ? match[1] : null
}

/** The marker line for a section called `name` (an HTML comment, so it never shows in exports). */
export function sectionMarkerLine(name: string): string {
  return `<!-- section: ${name.replace(/\s+/g, ' ').replace(/--+/g, '–').trim()} -->`
}

/** Section markers outside fenced code blocks and notes blocks. */
export function extractSectionMarkers(text: string): SectionMarker[] {
  const markers: SectionMarker[] = []
  let fence: string | null = null
  const lines = text.split('\n')
  const roles = classifyLines(lines)
  lines.forEach((line, index) => {
    if (roles[index] !== 'output') return
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1][0]
      else if (fenceMatch[1][0] === fence) fence = null
      return
    }
    if (fence !== null) return
    const name = parseSectionMarker(line)
    if (name !== null) markers.push({ name, line: index + 1 })
  })
  return markers
}

/** Removes section marker lines (for exporting the text). */
export function stripSectionMarkers(text: string): string {
  const drop = new Set(extractSectionMarkers(text).map((marker) => marker.line - 1))
  if (drop.size === 0) return text
  return text.split('\n').filter((_, index) => !drop.has(index)).join('\n').replace(/\n{3,}/g, '\n\n')
}
