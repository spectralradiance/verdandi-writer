import type { ChangeDesc } from '@codemirror/state'

import { splitSections } from '../../../shared/document'
import { classifyLines, NOTES_CLOSE_LINE, NOTES_OPEN_LINE } from '../../../shared/notes'
import { extractHeadings } from '../../../shared/text'

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
  /** The heading, or null for the text before the first heading. */
  title: string | null
}

/** Splits a file into sections that cover every line, so joining them gives the file back. */
export function partition(text: string): ModelSection[] {
  const lines = text.split('\n')
  const titled = splitSections(text).filter((section) => section.title !== null)
  const sections: ModelSection[] = []
  const first = titled[0]?.line ?? lines.length + 1
  if (first > 1) sections.push({ title: null, text: lines.slice(0, first - 1).join('\n') })
  for (const section of titled) {
    sections.push({ title: section.title, text: lines.slice(section.line - 1, section.endLine).join('\n') })
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

/** The section's heading as it reads now. */
export function sectionTitle(text: string): string | null {
  return extractHeadings(text)[0]?.text ?? null
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
  let lastText = -1
  roles.forEach((role, index) => {
    if (role === 'output' && lines[index].trim() !== '') lastText = index
  })
  // Blank lines at the end, and the blank line that sets a notes block apart, stay hidden.
  return roles.map((role, index) => role === 'output' && index <= lastText
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
