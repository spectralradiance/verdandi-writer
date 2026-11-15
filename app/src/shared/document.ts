// A single-file document: sections are split by headings, and each section can
// hold notes (`::: notes` blocks, see notes.ts) alongside its output text.

import { classifyLines, type LayerNames, NOTES_CLOSE_LINE, NOTES_OPEN_LINE } from './notes'
import { countWords, extractHeadings, extractSectionMarkers, type Heading, splitsAtMarkersOnly } from './text'

/** A section without its text, for outlines. */
export type SectionSummary = Pick<DocSection, 'title' | 'named' | 'heading' | 'level' | 'line' | 'endLine' | 'hasText' | 'outputWords' | 'notesWords' | 'headings'>

export function summarizeSections(text: string, layers?: LayerNames): SectionSummary[] {
  return splitSections(text, layers).map(({ title, named, heading, level, line, endLine, hasText, outputWords, notesWords, headings }) => (
    { title, named, heading, level, line, endLine, hasText, outputWords, notesWords, headings }
  ))
}

export interface DocSection {
  /** The section heading or name, or null for text before the first section. */
  title: string | null
  /** The section starts at a `<!-- section: Name -->` marker: it has a name but no heading. */
  named: boolean
  /** A folder document's marker says exports show the name as a heading (`.heading`). */
  heading: boolean
  level: number
  /** 1-based line of the heading (0 for the text before the first heading). */
  line: number
  /** 1-based last line of the section, inclusive. */
  endLine: number
  /** The section's text, without its heading and layer blocks. */
  output: string
  /** The contents of its layer blocks (its notes, in a one-file document). */
  notes: string
  /** Whether there is any text under the heading (besides notes). */
  hasText: boolean
  /** Words in the heading and the text, so the sections add up to the document's count. */
  outputWords: number
  notesWords: number
  /** Headings inside the section, below the section level. */
  headings: Heading[]
}

/**
 * The heading level that splits the document: `#` headings are sections. A
 * document without any uses its shallowest heading level instead.
 */
export function sectionLevel(headings: readonly Heading[]): number {
  if (headings.length === 0) return 1
  return Math.min(...headings.map((heading) => heading.level))
}

const joinLines = (lines: string[]) => lines.join('\n').replace(/^\n+|\s+$/g, '')

/**
 * Where sections start: section markers, and headings at the section level that do
 * not sit right under a marker. In a folder document (markers with ids), markers only.
 */
export function sectionStarts(text: string, layers?: LayerNames): { line: number; title: string; named: boolean; heading: boolean }[] {
  const lines = text.split('\n')
  const headings = extractHeadings(text, layers)
  const level = sectionLevel(headings)
  const markers = extractSectionMarkers(text, layers)
  const named = markers.map((marker) => ({ line: marker.line, title: marker.name, named: true, heading: marker.heading }))
  if (splitsAtMarkersOnly(markers)) return named
  const markerLines = new Set(markers.map((marker) => marker.line))
  // A heading right under a marker (blank lines aside) belongs to the marker's section.
  const underMarker = (line: number) => {
    let index = line - 2
    while (index >= 0 && lines[index].trim() === '') index -= 1
    return markerLines.has(index + 1)
  }
  return [
    ...named,
    ...headings.filter((heading) => heading.level === level && !underMarker(heading.line))
      .map((heading) => ({ line: heading.line, title: heading.text, named: false, heading: false })),
  ].sort((a, b) => a.line - b.line)
}

/**
 * Splits a document into sections at its headings and section markers. Headings
 * and markers inside notes never split.
 */
export function splitSections(text: string, layers?: LayerNames): DocSection[] {
  const lines = text.split('\n')
  const roles = classifyLines(lines, layers)
  const headings = extractHeadings(text, layers)
  const level = sectionLevel(headings)
  const starts = sectionStarts(text, layers)

  const sections: DocSection[] = []
  const build = (title: string | null, named: boolean, heading: boolean, headingLine: number, from: number, to: number): DocSection => {
    const output: string[] = []
    const notes: string[] = []
    let blockGap = false
    for (let index = from; index < to; index += 1) {
      if (roles[index] === 'output') output.push(lines[index].replace(/\r$/, ''))
      else if (roles[index] === 'notes') {
        if (blockGap && notes.length > 0) notes.push('')
        blockGap = false
        notes.push(lines[index].replace(/\r$/, ''))
      } else if (roles[index] === 'close') blockGap = true
    }
    const outputText = joinLines(output)
    const notesText = joinLines(notes)
    return {
      title,
      named,
      heading,
      level: title === null || named ? level : (headings.find((heading) => heading.line === headingLine)?.level ?? level),
      line: headingLine,
      endLine: to,
      output: outputText,
      notes: notesText,
      hasText: outputText.length > 0,
      outputWords: countWords(outputText) + (title === null || named ? 0 : countWords(lines[headingLine - 1])),
      notesWords: countWords(notesText),
      headings: headings.filter((heading) => heading.line > headingLine && heading.line <= to && heading.level > level),
    }
  }

  const firstLine = starts[0]?.line ?? lines.length + 1
  if (firstLine > 1) {
    const preamble = build(null, false, false, 0, 0, firstLine - 1)
    if (preamble.output || preamble.notes || starts.length === 0) sections.push(preamble)
  }
  starts.forEach((start, index) => {
    const end = (starts[index + 1]?.line ?? lines.length + 1) - 1
    sections.push(build(start.title, start.named, start.heading, start.line, start.line, end))
  })
  return sections
}

/** Words split into output and notes, for counts and daily statistics. */
export function splitWordCounts(text: string, layers?: LayerNames): { output: number; notes: number } {
  const lines = text.split('\n')
  const roles = classifyLines(lines, layers)
  const output: string[] = []
  const notes: string[] = []
  lines.forEach((line, index) => {
    if (roles[index] === 'output') output.push(line)
    else if (roles[index] === 'notes') notes.push(line)
  })
  return { output: countWords(output.join('\n')), notes: countWords(notes.join('\n')) }
}

export function hasNotes(text: string): boolean {
  return /^[ \t]{0,3}:{3,}[ \t]*notes[ \t]*\r?$/im.test(text)
}

/** The section that contains a 1-based line (the last section starting at or before it). */
export function sectionAtLine(sections: readonly DocSection[], line: number): number {
  let found = 0
  sections.forEach((section, index) => {
    if (section.line <= line) found = index
  })
  return found
}

export type NotesPlan =
  | { kind: 'jump'; line: number }
  | { kind: 'insert'; offset: number; insert: string; cursor: number }

/**
 * Where the notes of the section at `line` are: jump into its last notes block, or
 * add an empty block at the end of the section (before the next heading).
 */
export function planNotes(text: string, line: number): NotesPlan {
  const lines = text.split('\n')
  const roles = classifyLines(lines)
  const sections = splitSections(text)
  const section = sections[sectionAtLine(sections, line)]
  const from = Math.max(section?.line ?? 1, 1) - 1
  const to = section ? section.endLine : lines.length

  for (let index = to - 1; index >= from; index -= 1) {
    if (roles[index] === 'close' || roles[index] === 'notes' || roles[index] === 'open') {
      let open = index
      while (open > from && roles[open] !== 'open') open -= 1
      return { kind: 'jump', line: Math.min(open + 2, lines.length) }
    }
  }

  // Insert after the last non-blank line of the section.
  let last = to - 1
  while (last > from && lines[last].trim() === '') last -= 1
  const offsetAfter = lines.slice(0, last + 1).join('\n').length
  const atEnd = last >= lines.length - 1
  const block = `\n\n${NOTES_OPEN_LINE}\n\n${NOTES_CLOSE_LINE}${atEnd ? '\n' : ''}`
  return { kind: 'insert', offset: offsetAfter, insert: block, cursor: offsetAfter + 2 + NOTES_OPEN_LINE.length + 1 }
}

/**
 * Replaces the output of one section, keeping its heading and its notes blocks.
 * Returns the whole text, or null when the index is out of range.
 */
export function replaceSectionOutput(text: string, index: number, output: string, layers?: LayerNames): string | null {
  const lines = text.split('\n')
  const roles = classifyLines(lines, layers)
  const section = splitSections(text, layers)[index]
  if (!section) return null
  const from = Math.max(section.line, 1) - 1
  const heading = section.title === null ? [] : [lines[from]]
  const bodyFrom = section.title === null ? 0 : from + 1
  const blocks: string[][] = []
  let current: string[] | null = null
  for (let position = bodyFrom; position < section.endLine; position += 1) {
    if (roles[position] === 'open') current = [lines[position]]
    else if (current) {
      current.push(lines[position])
      if (roles[position] === 'close') {
        blocks.push(current)
        current = null
      }
    }
  }
  if (current) blocks.push(current)

  const parts: string[] = []
  if (heading.length) parts.push(heading[0])
  if (output.trim()) parts.push(output.replace(/^\n+|\s+$/g, ''))
  for (const block of blocks) parts.push(block.join('\n').replace(/\s+$/, ''))
  const replacement = parts.join('\n\n')
  const after = lines.slice(section.endLine)
  const before = lines.slice(0, from)
  return [...before, replacement, ...(after.length ? ['', ...after] : [''])].join('\n').replace(/\n{3,}/g, '\n\n')
}

/** Moves every heading down so none is shallower than `minimum` (so it cannot start a section). */
export function demoteHeadings(text: string, minimum: number): string {
  const headings = extractHeadings(text)
  if (headings.length === 0) return text
  const shift = minimum - Math.min(...headings.map((heading) => heading.level))
  if (shift <= 0) return text
  const lines = text.split('\n')
  for (const heading of headings) {
    lines[heading.line - 1] = lines[heading.line - 1].replace(/^(\s{0,3})(#{1,6})/, (_match, space: string, marks: string) =>
      `${space}${'#'.repeat(Math.min(6, marks.length + shift))}`)
  }
  return lines.join('\n')
}

/**
 * Moves the `from`th titled section (counting only sections that start with a heading,
 * so any text before the first heading stays put) to the position of the `to`th,
 * taking its notes and sub-headings with it. Returns null when nothing would change.
 */
export function moveSectionText(text: string, from: number, to: number, layers?: LayerNames): string | null {
  const sections = splitSections(text, layers).filter((section) => section.title !== null)
  if (from === to || from < 0 || to < 0 || from >= sections.length || to >= sections.length) return null
  const lines = text.split('\n')
  const head = lines.slice(0, sections[0].line - 1)
  const blocks = sections.map((section) => {
    const body = lines.slice(section.line - 1, section.endLine)
    let end = body.length
    while (end > 1 && body[end - 1].trim() === '') end -= 1
    return { body: body.slice(0, end), gap: body.length - end }
  })
  const lastGap = blocks[blocks.length - 1].gap
  const [moved] = blocks.splice(from, 1)
  blocks.splice(to, 0, moved)
  const out = [...head]
  blocks.forEach((block, index) => {
    out.push(...block.body)
    // Sections keep their own spacing, but never run into the next heading.
    const gap = index === blocks.length - 1 ? lastGap : Math.max(1, block.gap)
    for (let count = 0; count < gap; count += 1) out.push('')
  })
  return out.join('\n')
}
