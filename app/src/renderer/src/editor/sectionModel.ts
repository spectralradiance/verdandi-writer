import type { ChangeDesc } from '@codemirror/state'

import { moveSectionText, sectionLevel, splitSections } from '../../../shared/document'
import { blockOpenLine, classifyBlocks, type LayerNames, NOTES_CLOSE_LINE } from '../../../shared/notes'
import { newSectionId } from '../../../shared/layers'
import { extractHeadings, extractSectionMarkers, parseMarker, parseSectionMarker, sectionMarkerLine, splitsAtMarkersOnly } from '../../../shared/text'

/**
 * The model behind the sections editor. The file is split into sections at its
 * `#` headings (a document folder's, at its section markers), and each section is
 * shown as small editors: its output (the heading and the text) and each of its
 * layers (the inside of its `::: notes` blocks, or another layer's).
 *
 * Each editor holds a *projection* of its section: the lines it shows, plus the
 * lines it hides (the other kinds' text, block markers, the blank lines around
 * them), each hidden run anchored after one of the shown lines. An edit in the
 * editor moves the anchors with the text, and the section is put back together
 * from the new text and the hidden runs, so notes stay where they were in the file.
 *
 * `layers` is the document's layer names (null for a one-file document, whose only
 * layer is its notes), so the right blocks are recognized.
 */

/** The text itself (`output`), or a layer's name. */
export type CellKind = 'output' | (string & {})

export interface Projection {
  kind: CellKind
  layers: LayerNames
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
  /** In a document folder: the section file's id, from its marker. */
  id: string | null
}

/** Whether the text is a document folder's (its markers carry section ids). */
export function isFolderText(text: string, layers?: LayerNames): boolean {
  return splitsAtMarkersOnly(extractSectionMarkers(text, layers))
}

/** Splits a file into sections that cover every line, so joining them gives the file back. */
export function partition(text: string, layers?: LayerNames): ModelSection[] {
  const lines = text.split('\n')
  const titled = splitSections(text, layers).filter((section) => section.title !== null)
  const sections: ModelSection[] = []
  const first = titled[0]?.line ?? lines.length + 1
  if (first > 1) sections.push({ title: null, named: false, heading: false, id: null, text: lines.slice(0, first - 1).join('\n') })
  for (const section of titled) {
    const id = section.named ? (parseMarker(lines[section.line - 1])?.id ?? null) : null
    sections.push({ title: section.title, named: section.named, heading: section.heading, id, text: lines.slice(section.line - 1, section.endLine).join('\n') })
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
export function sectionTitle(text: string, layers?: LayerNames): string | null {
  const first = text.split('\n').find((line) => line.trim() !== '')
  const name = first === undefined ? null : parseSectionMarker(first)
  return name ?? extractHeadings(text, layers)[0]?.text ?? null
}

/** Which of a section's lines an editor of `kind` shows. */
function shownLines(lines: readonly string[], kind: CellKind, layers: LayerNames): boolean[] {
  const blocks = classifyBlocks(lines, layers)
  const roles = blocks.map((block) => block.role)
  if (kind !== 'output') {
    // Blank lines just inside a block's markers stay hidden.
    const shown = blocks.map((block) => block.role === 'notes' && block.layer === kind)
    const blank = (index: number) => lines[index].trim() === ''
    blocks.forEach((block, index) => {
      if (block.role !== 'open' || block.layer !== kind) return
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

export function project(text: string, kind: CellKind, layers: LayerNames = null): Projection {
  const lines = text.split('\n')
  const shown = shownLines(lines, kind, layers)
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
  if (visible.length === 0) return { kind, layers, text: '', lead: [], after: [[]], empty: true, lines }
  return { kind, layers, text: visible.join('\n'), lead, after, empty: false, lines: [] }
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
function insertionPoint(lines: readonly string[], kind: CellKind, layers: LayerNames): { before: string[]; after: string[] } {
  if (kind !== 'output') {
    // An empty block of the layer is filled in; otherwise a new one goes at the end of the section.
    // (Nothing is shown, so any block of it here holds only blank lines.)
    const open = classifyBlocks(lines, layers).findIndex((block) => block.role === 'open' && block.layer === kind)
    if (open >= 0) return { before: lines.slice(0, open + 1), after: lines.slice(open + 1) }
  }
  let last = lines.length - 1
  while (last >= 0 && lines[last].trim() === '') last -= 1
  const head = lines.slice(0, last + 1)
  const tail = lines.slice(last + 1)
  const gap = head.length > 0 ? [''] : []
  if (kind !== 'output') return { before: [...head, ...gap, blockOpenLine(kind)], after: [NOTES_CLOSE_LINE, ...tail] }
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
    const { before, after } = insertionPoint(projection.lines, projection.kind, projection.layers)
    return { kind: projection.kind, layers: projection.layers, text, lead: before, after: lines.map((_, index) => (index === lines.length - 1 ? after : [])), empty: false, lines: [] }
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

function replaceSection(
  text: string, index: number, change: (lines: string[], section: ModelSection) => string[] | null, layers?: LayerNames,
): string | null {
  const sections = partition(text, layers)
  const section = sections[index]
  if (!section) return null
  const lines = change(section.text.split('\n'), section)
  if (lines === null) return null
  const next = [...sections.slice(0, index), ...(lines.length ? [{ text: lines.join('\n') }] : []), ...sections.slice(index + 1)]
  return joinSections(next)
}

const HEADING = /^(\s{0,3})(#{1,6})(\s+)(.*?)(\s+#+)?\s*$/

/** Renames a section: its marker's name, or its heading's text. */
export function renameSection(text: string, index: number, name: string, layers?: LayerNames): string | null {
  const clean = name.replace(/\s+/g, ' ').trim()
  if (!clean) return null
  return replaceSection(text, index, (lines) => {
    const marker = parseMarker(lines[0])
    if (marker !== null) return [sectionMarkerLine(clean, marker), ...lines.slice(1)]
    const heading = HEADING.exec(lines[0])
    if (!heading) return null
    return [`${heading[1]}${heading[2]} ${clean}`, ...lines.slice(1)]
  }, layers)
}

/** Shows a section's name as a heading in the text, or keeps it as a name only. */
export function setSectionHeading(text: string, index: number, heading: boolean, layers?: LayerNames): string | null {
  const level = sectionLevel(extractHeadings(text, layers))
  const folder = isFolderText(text, layers)
  return replaceSection(text, index, (lines) => {
    // In a document folder the name stays a marker: whether it is a heading is the file's setting.
    const marker = parseMarker(lines[0])
    if (folder && marker !== null) return marker.heading === heading ? null : [sectionMarkerLine(marker.name, { ...marker, heading }), ...lines.slice(1)]
    const name = parseSectionMarker(lines[0])
    if (heading && name !== null) return [`${'#'.repeat(level)} ${name}`, ...lines.slice(1)]
    const match = HEADING.exec(lines[0])
    if (!heading && name === null && match) return [sectionMarkerLine(match[4]), ...lines.slice(1)]
    return null
  }, layers)
}

/**
 * Joins a section to the one before it: its marker goes, and its heading becomes a
 * subheading (so the words stay).
 */
export function mergeIntoPrevious(text: string, index: number, layers?: LayerNames): string | null {
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
  }, layers)
}

export function deleteSection(text: string, index: number, layers?: LayerNames): string | null {
  return replaceSection(text, index, () => [], layers)
}

/** Swaps a section with the one before (-1) or after (1). The text before the first section stays put. */
export function moveSection(text: string, index: number, direction: -1 | 1, layers?: LayerNames): string | null {
  const sections = partition(text, layers)
  const offset = sections[0]?.title === null ? 1 : 0
  if (index < offset) return null
  return moveSectionText(text, index - offset, index - offset + direction, layers)
}

const trimEnd = (lines: string[]) => {
  const out = [...lines]
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop()
  return out
}

/**
 * Takes the blocks of the `stay` layers out of `lines`, each with the blank line
 * that set it apart. Returns the lines left and the blocks, in order.
 */
function takeBlocks(lines: readonly string[], layers: LayerNames, stay: readonly string[]): { rest: string[]; blocks: string[][] } {
  if (stay.length === 0) return { rest: [...lines], blocks: [] }
  const roles = classifyBlocks(lines, layers)
  const rest: string[] = []
  const blocks: string[][] = []
  let block: string[] | null = null
  roles.forEach((role, at) => {
    if (block) {
      block.push(lines[at])
      if (role.role === 'close') block = null
    } else if (role.role === 'open' && role.layer !== null && stay.includes(role.layer)) {
      if (rest.length > 0 && rest[rest.length - 1].trim() === '') rest.pop()
      block = [lines[at]]
      blocks.push(block)
    } else {
      rest.push(lines[at])
    }
  })
  return { rest, blocks }
}

const markerFor = (text: string, layers: LayerNames) => {
  // A document folder's new sections get ids at once, so each one is a file of its own from the first save.
  const folder = isFolderText(text, layers)
  return (value: string) => sectionMarkerLine(value, folder ? { id: newSectionId() } : {})
}

/**
 * Starts a named section at line `line` (0-based) of section `index`, from the text.
 * With `end`, the new section stops before line `end.line`, and the rest of the
 * section after it continues as another named section, `end.name`, so the text keeps
 * its order. Anchored layers' blocks go with the paragraphs they follow; the blocks of
 * the `stay` layers (those not anchored, such as an outline) stay with the section
 * that was split, so the new sections start with those layers blank.
 * Null when the section would be left with nothing but its heading or name.
 */
export function splitSection(
  text: string, index: number, line: number, name: string, end?: { line: number; name: string }, layers?: LayerNames,
  stay: readonly string[] = [],
): string | null {
  const markerLine = markerFor(text, layers)
  return replaceSection(text, index, (lines, section) => {
    if (line < 1 || line >= lines.length) return null
    const before = trimEnd(lines.slice(0, line))
    const ownLine = section.title === null ? 0 : 1
    if (!before.slice(ownLine).some((value) => value.trim() !== '')) return null
    const continues = end && end.line > line && end.line < lines.length && lines.slice(end.line).some((value) => value.trim() !== '')
    const moved = takeBlocks(lines.slice(line, continues ? end.line : lines.length), layers, stay)
    const after = continues ? takeBlocks(lines.slice(end.line), layers, stay) : null
    const kept = [...moved.blocks, ...(after?.blocks ?? [])].flatMap((block) => ['', ...block])
    const split = [...before, ...kept, '', markerLine(name)]
    if (!after || !end) return [...split, ...moved.rest]
    return [...split, ...trimEnd(moved.rest), '', markerLine(end.name), ...after.rest]
  }, layers)
}

/**
 * Makes a new section, after section `index`, from lines `from` to `to` (0-based,
 * `to` not included) of the section's `kind` layer: those lines leave the section's
 * blocks of that layer (a block left empty goes too) and become the new section's
 * only content, so its text and its other layers start blank.
 * Null when there is nothing of the layer in those lines.
 */
export function splitFromLayer(
  text: string, index: number, kind: string, from: number, to: number, name: string, layers?: LayerNames,
): string | null {
  const markerLine = markerFor(text, layers)
  return replaceSection(text, index, (lines) => {
    const roles = classifyBlocks(lines, layers)
    const inLayer = (at: number) => roles[at].role === 'notes' && roles[at].layer === kind
    const moved: string[] = []
    const left: string[] = []
    let lastBlock = -1
    let block = -1
    roles.forEach((role, at) => {
      if (role.role === 'open') block = at
      if (at >= from && at < to && inLayer(at)) {
        // Lines from different blocks are kept apart by a blank line.
        if (lastBlock >= 0 && block !== lastBlock && moved.length > 0 && moved[moved.length - 1].trim() !== '') moved.push('')
        lastBlock = block
        moved.push(lines[at])
      } else {
        left.push(lines[at])
      }
    })
    const content = trimEnd(moved)
    while (content.length > 0 && content[0].trim() === '') content.shift()
    if (content.length === 0) return null
    // Blocks of the layer with nothing left in them go, with the blank line before them.
    const leftRoles = classifyBlocks(left, layers)
    const kept: string[] = []
    for (let at = 0; at < left.length; at += 1) {
      const role = leftRoles[at]
      if (role.role === 'open' && role.layer === kind) {
        let close = at + 1
        while (close < left.length && leftRoles[close].role !== 'close') close += 1
        if (left.slice(at + 1, close).every((value) => value.trim() === '')) {
          if (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop()
          at = close
          continue
        }
      }
      kept.push(left[at])
    }
    let body = kept.length
    while (body > 0 && kept[body - 1].trim() === '') body -= 1
    // The section's trailing blank lines (the file's last line break) stay at the end.
    return [...kept.slice(0, body), '', markerLine(name), blockOpenLine(kind), ...content, NOTES_CLOSE_LINE, ...kept.slice(body)]
  }, layers)
}

/** The name for the rest of a section after a split: “Name (continued)”. */
export function continuedName(title: string | null): string {
  if (title === null) return 'Continued'
  return `${title.replace(/\s*\(continued\)$/i, '')} (continued)`
}
