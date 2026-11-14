// Folder documents (PLAN.md §3b). A document is a folder holding a document note,
// which declares the document's layers and lists its sections in order as embeds,
// and one Markdown file per section. A section file's body is its text layer; the
// other layers are Obsidian callouts (`> [!notes]`) on disk. In the working text
// the editor uses, the same layers are fenced blocks (`::: notes` … `:::`), the
// form notes already take in a one-file document.

import { type Document, isMap, isScalar, isSeq, parseDocument } from 'yaml'

import { hasNotes, splitSections } from './document'
import { extractSectionMarkers, sectionMarkerLine } from './text'

// ---------------------------------------------------------------------------
// Frontmatter

const FRONTMATTER = /^---[ \t]*\n([\s\S]*?\n)?---[ \t]*(?:\n|$)/

export interface Frontmatter {
  /** The YAML between the `---` lines, with its final line break, or null when there is none. */
  yaml: string | null
  body: string
}

export function splitFrontmatter(text: string): Frontmatter {
  const match = FRONTMATTER.exec(text)
  if (!match) return { yaml: null, body: text }
  return { yaml: match[1] ?? '', body: text.slice(match[0].length) }
}

export function joinFrontmatter(yaml: string | null, body: string): string {
  if (yaml === null) return body
  const fields = yaml && !yaml.endsWith('\n') ? `${yaml}\n` : yaml
  return `---\n${fields}---\n${body}`
}

/** The frontmatter's fields, or none when it is missing or not valid YAML. */
export function readFields(yaml: string | null): Record<string, unknown> {
  if (!yaml) return {}
  const doc = parseDocument(yaml)
  if (doc.errors.length > 0 || !isMap(doc.contents)) return {}
  const value: unknown = doc.toJS()
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

export class FrontmatterError extends Error {}

/**
 * Edits frontmatter in place, keeping its comments and the order of its fields.
 * Returns null when there was none and the edit added nothing.
 */
export function editFields(yaml: string | null, edit: (doc: Document) => void): string | null {
  const doc: Document = parseDocument(yaml ?? '')
  if (doc.errors.length > 0) throw new FrontmatterError(`The frontmatter is not valid YAML: ${doc.errors[0].message}`)
  if (!isMap(doc.contents)) {
    const empty = doc.contents === null || (isScalar(doc.contents) && doc.contents.value === null)
    if (!empty) throw new FrontmatterError('The frontmatter is not a list of fields.')
    doc.contents = doc.createNode({})
  }
  edit(doc)
  if (yaml === null && isMap(doc.contents) && doc.contents.items.length === 0) return null
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false })
}

/** Sets fields (or removes those set to undefined). */
export function setFields(yaml: string | null, fields: Record<string, unknown>): string | null {
  return editFields(yaml, (doc) => {
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) doc.delete(key)
      else doc.set(key, value)
    }
  })
}

// ---------------------------------------------------------------------------
// Layers

export type LayerKind = 'prose' | 'list' | 'gallery'

export interface Layer {
  /** The callout type on disk, lowercase: letters, digits and hyphens. */
  name: string
  kind: LayerKind
  /** The layer's blocks sit after the paragraph they belong to, rather than at the end of the section. */
  anchored: boolean
}

export const NOTES_LAYER: Layer = { name: 'notes', kind: 'prose', anchored: true }

const LAYER_KINDS: readonly LayerKind[] = ['prose', 'list', 'gallery']
const LAYER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Whether `name` can name a layer. `text` is the section's own text, so it is taken. */
export function isLayerName(name: string): boolean {
  return LAYER_NAME.test(name) && name !== 'text'
}

/** The layers a document note declares. A bare name is a prose layer. */
export function parseLayers(value: unknown): Layer[] {
  if (!Array.isArray(value)) return []
  const layers: Layer[] = []
  for (const item of value) {
    const entry: Record<string, unknown> = typeof item === 'string' ? { name: item } : item && typeof item === 'object' ? (item as Record<string, unknown>) : {}
    const name = typeof entry.name === 'string' ? entry.name.trim().toLowerCase() : ''
    if (!isLayerName(name) || layers.some((layer) => layer.name === name)) continue
    const kind = LAYER_KINDS.includes(entry.kind as LayerKind) ? (entry.kind as LayerKind) : 'prose'
    layers.push({ name, kind, anchored: entry.anchored === true })
  }
  return layers
}

// ---------------------------------------------------------------------------
// Callouts on disk, fenced blocks in the working text

/** `> [!notes]`, with an optional fold sign (`-` collapsed, `+` open) and title after it. */
const CALLOUT = /^[ \t]{0,3}>[ \t]?\[!([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)\]([+-]?)(.*)$/
const QUOTE = /^[ \t]{0,3}>/
const QUOTE_PREFIX = /^[ \t]{0,3}>[ \t]?/
/** `::: notes`, with the callout's fold sign and title after a space: `::: notes - Title`. */
const BLOCK_OPEN = /^[ \t]{0,3}:{3,}[ \t]*([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)(?:[ \t](.*))?$/
const BLOCK_CLOSE = /^[ \t]{0,3}:{3,}[ \t]*$/
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/

export type LayerLineRole = 'text' | 'open' | 'layer' | 'close'

export interface LayerLine {
  role: LayerLineRole
  /** The layer of an open, layer or close line, as named in the document. */
  layer: string | null
}

/**
 * Classifies the lines of a working text: the section's text, or the opening line,
 * contents or closing line of a layer block. Blocks of names that are not layers
 * are text. A block that is never closed runs to the end. As with notes in a
 * one-file document, fenced code is respected inside and outside blocks.
 */
export function classifyLayerLines(lines: readonly string[], layers: readonly string[]): LayerLine[] {
  const names = new Set(layers.map((name) => name.toLowerCase()))
  const roles: LayerLine[] = []
  let layer: string | null = null
  let fence: string | null = null
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '')
    const inside = (): LayerLine => ({ role: layer === null ? 'text' : 'layer', layer })
    const fenceMatch = FENCE.exec(line)
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1][0]
      else if (fenceMatch[1][0] === fence) fence = null
      roles.push(inside())
      continue
    }
    if (fence !== null) {
      roles.push(inside())
      continue
    }
    const open: RegExpExecArray | null = layer === null ? BLOCK_OPEN.exec(line) : null
    if (open && names.has(open[1].toLowerCase())) {
      layer = open[1].toLowerCase()
      roles.push({ role: 'open', layer })
    } else if (layer !== null && BLOCK_CLOSE.test(line)) {
      roles.push({ role: 'close', layer })
      layer = null
    } else {
      roles.push(inside())
    }
  }
  return roles
}

/** The working text of a section file's body: its layer callouts as fenced blocks. */
export function calloutsToBlocks(body: string, layers: readonly string[]): string {
  const names = new Set(layers.map((name) => name.toLowerCase()))
  const lines = body.split('\n')
  const out: string[] = []
  let fence: string | null = null
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const fenceMatch = FENCE.exec(line)
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1][0]
      else if (fenceMatch[1][0] === fence) fence = null
    }
    const callout = fence === null ? CALLOUT.exec(line) : null
    if (!callout || !names.has(callout[1].toLowerCase())) {
      out.push(line)
      continue
    }
    const suffix = `${callout[2]}${callout[3]}`.trimEnd()
    out.push(`::: ${callout[1]}${suffix ? ` ${suffix}` : ''}`)
    while (index + 1 < lines.length && QUOTE.test(lines[index + 1])) {
      index += 1
      out.push(lines[index].replace(QUOTE_PREFIX, ''))
    }
    out.push(':::')
  }
  return out.join('\n')
}

/**
 * A section file's body from its working text: each layer block becomes a callout.
 * A blank line is added after a callout that a quote or another block follows
 * directly, since on disk the two would run together.
 */
export function blocksToCallouts(text: string, layers: readonly string[]): string {
  const lines = text.split('\n')
  const roles = classifyLayerLines(lines, layers)
  const out: string[] = []
  lines.forEach((line, index) => {
    const { role } = roles[index]
    if (role === 'open') {
      const open = BLOCK_OPEN.exec(line.replace(/\r$/, ''))!
      const suffix = (open[2] ?? '').trimEnd()
      out.push(`> [!${open[1]}]${suffix}`)
    } else if (role === 'layer') {
      out.push(line === '' ? '>' : `> ${line}`)
    } else if (role === 'close') {
      const next = lines[index + 1]
      if (next !== undefined && (QUOTE.test(next) || roles[index + 1].role === 'open')) out.push('')
    } else {
      out.push(line)
    }
  })
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// Section files

export interface SectionFile {
  yaml: string | null
  /** The section's stable id, which finds it again when its embed goes stale. */
  id: string | null
  /** The exact title, given in frontmatter when the filename could not hold it. */
  title: string | null
  /** Whether exports show the section's name as a heading (`heading: false` when it is a name only). */
  heading: boolean
  /** The working text: the section's text, with its layers as fenced blocks. */
  text: string
}

export function parseSectionFile(source: string, layers: readonly string[]): SectionFile {
  const { yaml, body } = splitFrontmatter(source)
  const fields = readFields(yaml)
  const id = typeof fields.id === 'string' || typeof fields.id === 'number' ? String(fields.id) : null
  const title = typeof fields.title === 'string' && fields.title.trim() ? fields.title : null
  return { yaml, id, title, heading: fields.heading !== false, text: calloutsToBlocks(body, layers) }
}

export function writeSectionFile(file: Pick<SectionFile, 'yaml' | 'text'>, layers: readonly string[]): string {
  return joinFrontmatter(file.yaml, blocksToCallouts(file.text, layers))
}

/** A new random section id: eight lowercase letters and digits. */
export function newSectionId(): string {
  const bytes = new Uint8Array(8)
  globalThis.crypto.getRandomValues(bytes)
  return [...bytes].map((byte) => (byte % 36).toString(36)).join('')
}

// ---------------------------------------------------------------------------
// Document notes

/** A line that is only an embed: `![[Name]]`, `![[Name.md]]`, `![[Name|alias]]` or `![[Name#heading]]`. */
const EMBED = /^[ \t]*!\[\[([^\]|#^]+?)(?:\.md)?(?:[#^][^\]|]*)?(?:\|[^\]]*)?\]\][ \t]*$/i

export interface DocumentNote {
  yaml: string | null
  layers: Layer[]
  /** The sections in order: the target of each embed, without `.md`. */
  sections: string[]
  body: string
}

/** Whether a note is a document note: its frontmatter has `verdandi: document`. */
export function isDocumentNote(text: string): boolean {
  return readFields(splitFrontmatter(text).yaml).verdandi === 'document'
}

/** The embed lines of a body that are outside fenced code, with their targets. */
function embedLines(lines: readonly string[]): { index: number; target: string }[] {
  const found: { index: number; target: string }[] = []
  let fence: string | null = null
  lines.forEach((line, index) => {
    const fenceMatch = FENCE.exec(line)
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1][0]
      else if (fenceMatch[1][0] === fence) fence = null
      return
    }
    if (fence !== null) return
    const embed = EMBED.exec(line)
    if (embed) found.push({ index, target: embed[1].trim() })
  })
  return found
}

export function parseDocumentNote(text: string): DocumentNote {
  const { yaml, body } = splitFrontmatter(text)
  const fields = readFields(yaml)
  return {
    yaml,
    layers: parseLayers(fields.layers),
    sections: embedLines(body.split('\n')).map((embed) => embed.target),
    body,
  }
}

/** The YAML value for a layer, as written in the document note. */
function layerValue(layer: Layer): Record<string, unknown> {
  return layer.anchored ? { name: layer.name, kind: layer.kind, anchored: true } : { name: layer.name, kind: layer.kind }
}

/**
 * The document note with new layers or a new section order. Embeds keep the form
 * they were written in (an alias, say); other lines in the note stay where they are,
 * and the embeds go where the first one was.
 */
export function writeDocumentNote(text: string, change: { layers?: readonly Layer[]; sections?: readonly string[] }): string {
  let { yaml, body } = splitFrontmatter(text)
  if (change.layers) {
    const layers = change.layers
    yaml = editFields(yaml, (doc) => {
      doc.set('verdandi', 'document')
      const node = doc.createNode(layers.map(layerValue))
      if (isSeq(node)) for (const item of node.items) if (isMap(item)) item.flow = true
      doc.set('layers', node)
    })
  }
  if (change.sections) {
    const lines = body.split('\n')
    const embeds = embedLines(lines)
    const written = new Map<string, string>()
    for (const embed of embeds) if (!written.has(embed.target.toLowerCase())) written.set(embed.target.toLowerCase(), lines[embed.index].trim())
    const next = change.sections.map((target) => written.get(target.toLowerCase()) ?? `![[${target}]]`)
    if (embeds.length > 0) {
      const drop = new Set(embeds.map((embed) => embed.index))
      const out: string[] = []
      lines.forEach((line, index) => {
        if (index === embeds[0].index) out.push(...next)
        else if (!drop.has(index)) out.push(line)
      })
      body = out.join('\n')
    } else if (next.length > 0) {
      const kept = body.replace(/\s+$/, '')
      body = `${kept ? `${kept}\n\n` : ''}${next.join('\n')}\n`
    }
  }
  return joinFrontmatter(yaml, body)
}

/** A new document note declaring `layers` and listing `sections`. */
export function newDocumentNote(layers: readonly Layer[], sections: readonly string[]): string {
  return writeDocumentNote('---\nverdandi: document\n---\n', { layers, sections })
}

// ---------------------------------------------------------------------------
// Converting a one-file document

const RESERVED_NAME = /^(con|prn|aux|nul|com\d|lpt\d)$/i

/**
 * A filename (without `.md`) that holds `title` as closely as Windows, macOS and
 * Obsidian's links allow.
 */
export function fileNameFor(title: string): string {
  let name = title
    .replace(/"/g, "'")
    .replace(/:/g, ' -')
    .replace(/[/\\|]/g, '-')
    .replace(/[?*<>#^[\]]/g, '')
    .replace(/\p{Cc}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
  if (name.length > 120) name = name.slice(0, 120).replace(/[. ]+$/, '')
  if (!name) name = 'Untitled'
  if (RESERVED_NAME.test(name)) name = `${name} section`
  return name
}

/** `name`, or `name 2`, `name 3` … whichever is not yet in `taken` (lowercase). Adds it. */
export function uniqueName(name: string, taken: Set<string>): string {
  let candidate = name
  for (let count = 2; taken.has(candidate.toLowerCase()); count += 1) candidate = `${name} ${count}`
  taken.add(candidate.toLowerCase())
  return candidate
}

/** Whether a one-file document already uses Verdandi's own syntax: notes blocks or section markers. */
export function looksLikeVerdandiDocument(text: string): boolean {
  return hasNotes(text) || extractSectionMarkers(text).length > 0
}

export interface ConvertedDocument {
  /** The document note, named after the document. */
  note: string
  /** The section files in order: each one's name (without `.md`) and contents. */
  sections: { name: string; text: string }[]
}

export const INTRODUCTION = 'Introduction'

const trimBlankLines = (lines: string[]) => {
  let from = 0
  let to = lines.length
  while (from < to && lines[from].trim() === '') from += 1
  while (to > from && lines[to - 1].trim() === '') to -= 1
  return lines.slice(from, to)
}

/**
 * Splits a one-file document into a document note and section files, as on first
 * opening it. Each section that starts at a heading or a section marker becomes a
 * file, the text before the first one becomes "Introduction", and notes blocks
 * become `> [!notes]` callouts.
 */
export function convertOneFile(text: string, documentName: string, newId: () => string = newSectionId): ConvertedDocument {
  const lines = text.split('\n')
  const taken = new Set([documentName.toLowerCase()])
  // A blank preamble has no section; a file with no sections at all still gets one.
  const files = splitSections(text).map((section) => {
    const titled = section.title !== null
    const title = section.title ?? INTRODUCTION
    const name = uniqueName(fileNameFor(title), taken)
    const body = trimBlankLines(lines.slice(titled ? section.line : 0, section.endLine))
    const yaml = setFields(null, {
      id: newId(),
      title: name === title ? undefined : title,
      heading: titled && !section.named ? undefined : false,
    })
    const working = body.length > 0 ? `${body.join('\n')}\n` : ''
    return { name, text: writeSectionFile({ yaml, text: working }, [NOTES_LAYER.name]) }
  })
  return { note: newDocumentNote([NOTES_LAYER], files.map((file) => file.name)), sections: files }
}

// ---------------------------------------------------------------------------
// A folder document as the editor sees it: one text
//
// Each section is its marker, `<!-- section: Name {#id .heading} -->`, then its working
// text. The id says which file the section is; `.heading` that exports show the name as
// a heading. Markers with ids make only markers start sections (see `sectionStarts`),
// so a heading in a section's text never splits it.

export interface AssembledSection {
  /** The section file's id; null for a section made in the editor and not saved yet. */
  id: string | null
  name: string
  heading: boolean
  /** The working text. */
  text: string
}

export interface DisassembledSection extends AssembledSection {
  /** The section's lines as they are in the text, to tell which sections changed. */
  segment: string
  /** The 1-based line of its marker; 0 for text before the first marker. */
  line: number
}

/** A stable id made from `seed`: eight base-36 characters of its FNV-1a hash. */
export function stableId(seed: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `s${hash.toString(36).padStart(7, '0')}`
}

/** One section's lines in the editor's text: its marker, then its text without the final line break. */
export function assembleSection(section: AssembledSection): string {
  const marker = sectionMarkerLine(section.name, { id: section.id, heading: section.heading })
  const body = section.text.endsWith('\n') ? section.text.slice(0, -1) : section.text
  return body ? `${marker}\n${body}` : marker
}

export function assembleDocument(sections: readonly AssembledSection[]): string {
  return sections.map(assembleSection).join('\n')
}

/**
 * The sections of the editor's text. Text before the first marker (typed or pasted
 * there) becomes a section of its own, "Introduction".
 */
export function disassembleDocument(text: string): DisassembledSection[] {
  const lines = text.split('\n')
  const markers = extractSectionMarkers(text)
  const sections: DisassembledSection[] = []
  const first = markers[0]?.line ?? lines.length + 1
  const preamble = lines.slice(0, first - 1)
  if (preamble.some((line) => line.trim() !== '')) {
    sections.push({ id: null, name: INTRODUCTION, heading: false, text: `${preamble.join('\n')}\n`, segment: preamble.join('\n'), line: 0 })
  }
  markers.forEach((marker, index) => {
    const end = (markers[index + 1]?.line ?? lines.length + 1) - 1
    const body = lines.slice(marker.line, end)
    sections.push({
      id: marker.id,
      name: marker.name,
      heading: marker.heading,
      text: body.length > 0 ? `${body.join('\n')}\n` : '',
      segment: lines.slice(marker.line - 1, end).join('\n'),
      line: marker.line,
    })
  })
  return sections
}

/** A section's working text as written to its file: no blank lines at either end. */
export function tidySectionText(text: string): string {
  const lines = trimBlankLines(text.split('\n'))
  return lines.length > 0 ? `${lines.join('\n')}\n` : ''
}

/** The text with a folder document's `.heading` markers turned into `#` headings, for export. */
export function markersToHeadings(text: string): string {
  const markers = extractSectionMarkers(text).filter((marker) => marker.heading)
  if (markers.length === 0) return text
  const lines = text.split('\n')
  for (const marker of markers) lines[marker.line - 1] = `# ${marker.name}`
  return lines.join('\n')
}
