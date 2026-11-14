import type { ChangeDesc } from '@codemirror/state'

import { moveSectionText, sectionLevel, splitSections } from '../../../shared/document'
import { classifyLines, NOTES_CLOSE_LINE, NOTES_OPEN_LINE } from '../../../shared/notes'
import { newSectionId } from '../../../shared/layers'
import { extractHeadings, extractSectionMarkers, parseMarker, parseSectionMarker, sectionMarkerLine, splitsAtMarkersOnly } from '../../../shared/text'

/**
 * The model behind the two-column editor. The file is split into sections at its
 * `#` headings, and each section is shown as two small editors: its output (the
 * heading and the text) and its notes (the inside of its `::: notes` blocks).
 *
 * Each editor holds a *projection* of its section: the lines it shows, plus the
 * lines it hides (the other kind's text, notes markers, the blank lines around
 * them), each hidden run anchored after one of the shown lines. An edit in the
 * editor moves the anchors with the text, and the section is put back together
 * from the new text and the hidden runs, so notes stay where they were in the file.
 */

export type CellKind = 'output' | 'notes'

export interface Projection {
  kind: CellKind
  /** What the editor shows. */
  text: string
  /** Hidden lines before the first shown line. */
  lead: string[]
  /** after[k]: hidden lines right after shown line k. */
  after: string[][]
  /**
   * Nothing is shown: the editor's one empty line is not in the file, and `lines`
   * is the whole section, kept for when the writer starts typing.
   */
  empty: boolean
  lines: string[]
}

export interface ModelSection {
  /** The section's lines, joined with \n. Sections joined with \n make the file. */
  text: string
  /** The heading or name, or null for the text before the first section. */
  title: string | null
  /** Starts at a `<!-- section: Name -->` marker rather than a heading. */
  named: boolean
  /** In a document folder: exports show the name as a heading. */
  heading: boolean
}

/** Whether the text is a document folder's (its markers carry section ids). */
export function isFolderText(text: string): boolean {
  return splitsAtMarkersOnly(extractSectionMarkers(text))
}

/** Splits a file into sections that cover every line, so joining them gives the file back. */
export function partition(text: string): ModelSection[] {
  const lines = text.split('\n')
  const titled = splitSections(text).filter((section) => section.title !== null)
  const sections: ModelSection[] = []
  const first = titled[0]?.line ?? lines.length + 1
  if (first > 1) sections.push({ title: null, named: false, heading: false, text: lines.slice(0, first - 1).join('\n') })
  for (const section of titled) {
    sections.push({ title: section.title, named: section.named, heading: section.heading, text: lines.slice(section.line - 1, section.endLine).join('\n') })
  }
  return sections
}

export function joinSections(sections: readonly { text: string }[]): string {
  return sections.map((section) => section.text).join('\n')
}

/** Whether the text before the first heading is worth a row of its own. */
export function showsPreamble(sections: readonly ModelSection[]): boolean {
  const first = sections[0]
  if (!first || first.title !== null) return false
  return sections.length === 1 || first.text.trim() !== ''
}

/** The section's name as it reads now: its marker's, or its heading. */
export function sectionTitle(text: string): string | null {
  const first = text.split('\n').find((line) => line.trim() !== '')
  const name = first === undefined ? null : parseSectionMarker(first)
  return name ?? extractHeadings(text)[0]?.text ?? null
}

/** Which of a section's lines an editor of `kind` shows. */
function shownLines(lines: readonly string[], kind: CellKind): boolean[] {
  const roles = classifyLines(lines)
  if (kind === 'notes') {
    // Blank lines just inside a block's markers stay hidden.
    const shown = roles.map((role) => role === 'notes')
    const blank = (index: number) => lines[index].trim() === ''
    roles.forEach((role, index) => {
      if (role !== 'open') return
      let end = index + 1
      while (end < lines.length && roles[end] === 'notes') end += 1
      for (let at = index + 1; at < end && blank(at); at += 1) shown[at] = false
      for (let at = end - 1; at > index && blank(at); at -= 1) shown[at] = false
    })
    return shown
  }
  // Section markers are the section's name, shown above the row rather than in the text.
  const marker = lines.map((line, index) => roles[index] === 'output' && parseSectionMarker(line) !== null)
  const text = (index: number) => roles[index] === 'output' && !marker[index] && lines[index].trim() !== ''
  let firstText = -1
  let lastText = -1
  roles.forEach((_, index) => {
    if (!text(index)) return
    if (firstText < 0) firstText = index
    lastText = index
  })
  // Blank lines at either end, and the blank line that sets a notes block apart, stay hidden.
  return roles.map((role, index) => role === 'output' && !marker[index] && index >= firstText && index <= lastText
    && !(lines[index].trim() === '' && roles[index + 1] === 'open'))
}

export function project(text: string, kind: CellKind): Projection {
  const lines = text.split('\n')
  const shown = shownLines(lines, kind)
  const visible: string[] = []
  const lead: string[] = []
  const after: string[][] = []
  lines.forEach((line, index) => {
    if (shown[index]) {
      visible.push(line)
      after.push([])
    } else if (after.length === 0) {
      lead.push(line)
    } else {
      after[after.length - 1].push(line)
    }
  })
  if (visible.length === 0) return { kind, text: '', lead: [], after: [[]], empty: true, lines }
  return { kind, text: visible.join('\n'), lead, after, empty: false, lines: [] }
}

/** The section text a projection stands for. */
export function sectionText(projection: Projection): string {
  if (projection.empty) return projection.lines.join('\n')
  const out = [...projection.lead]
  projection.text.split('\n').forEach((line, index) => out.push(line, ...(projection.after[index] ?? [])))
  return out.join('\n')
}

/** Offsets where each line of `text` starts. */
function lineStarts(text: string): number[] {
  const starts = [0]
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) starts.push(index + 1)
  return starts
}

function lineAt(starts: readonly number[], offset: number): number {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (starts[middle] <= offset) low = middle
    else high = middle - 1
  }
  return low
}

/** Where typing into an empty editor goes in the section, as the lines before and after it. */
function insertionPoint(lines: readonly string[], kind: CellKind): { before: string[]; after: string[] } {
  const roles = classifyLines(lines)
  if (kind === 'notes') {
    // An empty notes block is filled in; otherwise a new one goes after the section's text.
    // (Nothing is shown, so any block here holds only blank lines.)
    const open = roles.indexOf('open')
    if (open >= 0) return { before: lines.slice(0, open + 1), after: lines.slice(open + 1) }
  }
  let last = lines.length - 1
  while (last >= 0 && lines[last].trim() === '') last -= 1
  const head = lines.slice(0, last + 1)
  const tail = lines.slice(last + 1)
  const gap = head.length > 0 ? [''] : []
  if (kind === 'notes') return { before: [...head, ...gap, NOTES_OPEN_LINE], after: [NOTES_CLOSE_LINE, ...tail] }
  return { before: [...head, ...gap], after: tail.length > 0 ? tail : [''] }
}

/**
 * The projection after the editor's text changed from `projection.text` to `text`
 * through `changes`: hidden runs follow the end of the line they were after.
 */
export function applyChange(projection: Projection, text: string, changes: ChangeDesc): Projection {
  const lines = text.split('\n')
  if (projection.empty) {
    if (text === '') return projection
    const { before, after } = insertionPoint(projection.lines, projection.kind)
    return { kind: projection.kind, text, lead: before, after: lines.map((_, index) => (index === lines.length - 1 ? after : [])), empty: false, lines: [] }
  }
  const oldStarts = lineStarts(projection.text)
  const newStarts = lineStarts(text)
  const after: string[][] = lines.map(() => [])
  projection.after.forEach((run, index) => {
    if (run.length === 0) return
    const end = index + 1 < oldStarts.length ? oldStarts[index + 1] - 1 : projection.text.length
    after[lineAt(newStarts, changes.mapPos(end, 1))].push(...run)
  })
  return { ...projection, text, after }
}

/** The 0-based line of the section each shown line of the projection is on. */
export function shownLineNumbers(projection: Projection): number[] {
  if (projection.empty) return []
  const numbers: number[] = []
  let line = projection.lead.length
  projection.text.split('\n').forEach((_, index) => {
    numbers.push(line)
    line += 1 + (projection.after[index]?.length ?? 0)
  })
  return numbers
}

/** The offset in the section text of an offset in the editor. */
export function toSectionOffset(projection: Projection, offset: number): number {
  if (projection.empty) return 0
  const starts = lineStarts(projection.text)
  const line = lineAt(starts, offset)
  const sectionStarts = lineStarts(sectionText(projection))
  return sectionStarts[shownLineNumbers(projection)[line]] + (offset - starts[line])
}

/** The editor offset of a section offset, or null when that part of the section is hidden here. */
export function fromSectionOffset(projection: Projection, offset: number): number | null {
  if (projection.empty) return null
  const sectionStarts = lineStarts(sectionText(projection))
  const sectionLine = lineAt(sectionStarts, offset)
  const index = shownLineNumbers(projection).indexOf(sectionLine)
  if (index < 0) return null
  return lineStarts(projection.text)[index] + (offset - sectionStarts[sectionLine])
}

/**
 * Lines up old and new sections: the unchanged ones at either end, and the run in
 * between that differs. Rows outside the run keep their editors as they are.
 */
export function changedRun(before: readonly string[], after: readonly string[]): { start: number; endBefore: number; endAfter: number } {
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1
  let endBefore = before.length
  let endAfter = after.length
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore -= 1
    endAfter -= 1
  }
  return { start, endBefore, endAfter }
}

// Section operations, on the whole text and a section's index in `partition`.

function replaceSection(text: string, index: number, change: (lines: string[], section: ModelSection) => string[] | null): string | null {
  const sections = partition(text)
  const section = sections[index]
  if (!section) return null
  const lines = change(section.text.split('\n'), section)
  if (lines === null) return null
  const next = [...sections.slice(0, index), ...(lines.length ? [{ text: lines.join('\n') }] : []), ...sections.slice(index + 1)]
  return joinSections(next)
}

const HEADING = /^(\s{0,3})(#{1,6})(\s+)(.*?)(\s+#+)?\s*$/

/** Renames a section: its marker's name, or its heading's text. */
export function renameSection(text: string, index: number, name: string): string | null {
  const clean = name.replace(/\s+/g, ' ').trim()
  if (!clean) return null
  return replaceSection(text, index, (lines) => {
    const marker = parseMarker(lines[0])
    if (marker !== null) return [sectionMarkerLine(clean, marker), ...lines.slice(1)]
    const heading = HEADING.exec(lines[0])
    if (!heading) return null
    return [`${heading[1]}${heading[2]} ${clean}`, ...lines.slice(1)]
  })
}

/** Shows a section's name as a heading in the text, or keeps it as a name only. */
export function setSectionHeading(text: string, index: number, heading: boolean): string | null {
  const level = sectionLevel(extractHeadings(text))
  const folder = isFolderText(text)
  return replaceSection(text, index, (lines) => {
    // In a document folder the name stays a marker: whether it is a heading is the file's setting.
    const marker = parseMarker(lines[0])
    if (folder && marker !== null) return marker.heading === heading ? null : [sectionMarkerLine(marker.name, { ...marker, heading }), ...lines.slice(1)]
    const name = parseSectionMarker(lines[0])
    if (heading && name !== null) return [`${'#'.repeat(level)} ${name}`, ...lines.slice(1)]
    const match = HEADING.exec(lines[0])
    if (!heading && name === null && match) return [sectionMarkerLine(match[4]), ...lines.slice(1)]
    return null
  })
}

/**
 * Joins a section to the one before it: its marker goes, and its heading becomes a
 * subheading (so the words stay).
 */
export function mergeIntoPrevious(text: string, index: number): string | null {
  if (index < 1) return null
  return replaceSection(text, index, (lines) => {
    const marker = parseMarker(lines[0])
    // A document folder's section shown as a heading keeps its name as a subheading.
    if (marker?.heading) return [`## ${marker.name}`, ...lines.slice(1)]
    if (marker !== null) {
      let start = 1
      while (start < lines.length - 1 && lines[start].trim() === '') start += 1
      return lines.slice(start)
    }
    const heading = HEADING.exec(lines[0])
    if (!heading) return null
    if (heading[2].length >= 6) return lines.slice(1)
    return [`${heading[1]}#${heading[2]}${heading[3]}${heading[4]}`, ...lines.slice(1)]
  })
}

export function deleteSection(text: string, index: number): string | null {
  return replaceSection(text, index, () => [])
}

/** Swaps a section with the one before (-1) or after (1). The text before the first section stays put. */
export function moveSection(text: string, index: number, direction: -1 | 1): string | null {
  const sections = partition(text)
  const offset = sections[0]?.title === null ? 1 : 0
  if (index < offset) return null
  return moveSectionText(text, index - offset, index - offset + direction)
}

const trimEnd = (lines: string[]) => {
  const out = [...lines]
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop()
  return out
}

/**
 * Starts a named section at line `line` (0-based) of section `index`. With `end`, the
 * new section stops before line `end.line`, and the rest of the section after it
 * continues as another named section, `end.name`, so the text keeps its order.
 * Null when the section would be left with nothing but its heading or name.
 */
export function splitSection(text: string, index: number, line: number, name: string, end?: { line: number; name: string }): string | null {
  // A document folder's new sections get ids at once, so each one is a file of its own from the first save.
  const folder = isFolderText(text)
  const markerLine = (value: string) => sectionMarkerLine(value, folder ? { id: newSectionId() } : {})
  return replaceSection(text, index, (lines, section) => {
    if (line < 1 || line >= lines.length) return null
    const before = trimEnd(lines.slice(0, line))
    const ownLine = section.title === null ? 0 : 1
    if (!before.slice(ownLine).some((value) => value.trim() !== '')) return null
    const split = [...before, '', markerLine(name)]
    if (!end || end.line <= line || end.line >= lines.length || !lines.slice(end.line).some((value) => value.trim() !== '')) {
      return [...split, ...lines.slice(line)]
    }
    return [...split, ...trimEnd(lines.slice(line, end.line)), '', markerLine(end.name), ...lines.slice(end.line)]
  })
}

/** The name for the rest of a section after a split: “Name (continued)”. */
export function continuedName(title: string | null): string {
  if (title === null) return 'Continued'
  return `${title.replace(/\s*\(continued\)$/i, '')} (continued)`
}
