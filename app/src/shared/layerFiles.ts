// Layer files (PLAN.md §3c, docs/FORMAT.md). A document is a main file, whose
// frontmatter says `verdandi: document` and whose body is the text, and one file
// per other layer. Sections are headings at the same level in every file, matched
// by name. The editor keeps its working text (see layers.ts): section markers, and
// each layer as `::: layer` blocks at the end of its section. This module turns the
// files into that text and back; it does no I/O.

import { isMap, isSeq } from 'yaml'

import { editFields, type Layer, parseLayers, readFields, splitFrontmatter, stableId } from './layers'
import { classifyBlocks } from './notes'
import { extractSectionMarkers, sectionMarkerLine } from './text'

export const DEFAULT_SECTION_LEVEL = 2

/** A declared layer, with the file it is in when that is not the default name. */
export interface LayerDeclaration extends Layer {
  file?: string
}

// ---------------------------------------------------------------------------
// Headings

const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/
const ATX = /^[ \t]{0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/

export interface HeadingSection {
  name: string
  /** The lines under the heading, up to the next one at the same level. */
  lines: string[]
}

export interface HeadingSplit {
  /** The lines before the first section: the title and anything the document as a whole has. */
  preamble: string[]
  sections: HeadingSection[]
}

/** The level and text of an ATX heading line, or null. */
function headingOf(line: string): { level: number; name: string } | null {
  const match = ATX.exec(line)
  if (!match) return null
  const name = match[2].trim()
  return name ? { level: match[1].length, name } : null
}

/** Splits a body at its headings of `level`, outside fenced code. Deeper and shallower headings stay where they are. */
export function splitAtHeadings(body: string, level: number): HeadingSplit {
  const lines = body.split('\n')
  if (lines.at(-1) === '') lines.pop()
  const split: HeadingSplit = { preamble: [], sections: [] }
  let fence: string | null = null
  for (const line of lines) {
    const opened = FENCE.exec(line)
    if (opened) {
      if (fence === null) fence = opened[1][0]
      else if (opened[1][0] === fence) fence = null
    }
    const heading = fence === null && !opened ? headingOf(line) : null
    if (heading && heading.level === level) {
      split.sections.push({ name: heading.name, lines: [] })
      continue
    }
    const current = split.sections.at(-1)
    if (current) current.lines.push(line)
    else split.preamble.push(line)
  }
  return split
}

/** `lines` without blank lines at either end. */
export function trimLines(lines: readonly string[]): string[] {
  let from = 0
  let to = lines.length
  while (from < to && lines[from].trim() === '') from += 1
  while (to > from && lines[to - 1].trim() === '') to -= 1
  return lines.slice(from, to)
}

const content = (lines: readonly string[]) => trimLines(lines).join('\n')

// ---------------------------------------------------------------------------
// The main file

export interface MainFile {
  yaml: string | null
  level: number
  layers: LayerDeclaration[]
  /** Each section's fields under `sections`, by name, as written (with `heading`). */
  fields: Record<string, Record<string, unknown>>
  split: HeadingSplit
}

/** Whether a file is a document's main file (or a §3b document note: both say `verdandi: document`). */
export function isMainFile(text: string): boolean {
  return readFields(splitFrontmatter(text).yaml).verdandi === 'document'
}

function parseDeclarations(value: unknown): LayerDeclaration[] {
  const layers: LayerDeclaration[] = parseLayers(value).map((layer) => ({ ...layer, anchored: false }))
  if (!Array.isArray(value)) return layers
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    const layer = layers.find((candidate) => candidate.name === String(entry.name ?? '').trim().toLowerCase())
    if (layer && typeof entry.file === 'string' && entry.file.trim()) layer.file = entry.file.trim()
  }
  return layers
}

function parseSectionFields(value: unknown): Record<string, Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const fields: Record<string, Record<string, unknown>> = {}
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) fields[name] = { ...(entry as Record<string, unknown>) }
  }
  return fields
}

export function parseMainFile(text: string): MainFile {
  const { yaml, body } = splitFrontmatter(text)
  const values = readFields(yaml)
  const level = typeof values['section-level'] === 'number' && Number.isInteger(values['section-level'])
    ? Math.min(Math.max(values['section-level'], 1), 6)
    : DEFAULT_SECTION_LEVEL
  return { yaml, level, layers: parseDeclarations(values.layers), fields: parseSectionFields(values.sections), split: splitAtHeadings(body, level) }
}

/** A layer's file name: the one declared, or `<Document> - <Layer>.md`. */
export function layerFileName(documentName: string, layer: LayerDeclaration): string {
  if (layer.file) return /\.md$/i.test(layer.file) ? layer.file : `${layer.file}.md`
  return `${documentName} - ${layer.name.charAt(0).toUpperCase()}${layer.name.slice(1)}.md`
}

/** Whether a layer's file has the default name, so renaming the layer or the document renames it. */
export const hasDefaultFile = (layer: LayerDeclaration) => !layer.file

// ---------------------------------------------------------------------------
// Files to working text

/** A heading in a layer file that matches no section, kept as it is. */
export interface StraySection {
  layer: string
  name: string
  lines: string[]
}

export interface AssembledSection {
  /** Made from the name and its place among sections of that name, so it is the same every time the files are read. */
  id: string
  name: string
  heading: boolean
  /** Its fields, without `heading`. */
  fields: Record<string, unknown>
}

export interface Assembled {
  text: string
  sections: AssembledSection[]
  strays: StraySection[]
  /** Layer headings paired with a renamed section: `layer`'s heading `from` is section `to`. */
  paired: { layer: string; from: string; to: string }[]
  /** `sections` keys that match no heading. */
  orphanFields: string[]
}

/** A section's id: its name and which of the sections of that name it is. */
export const sectionId = (name: string, occurrence: number) => stableId(`section:${name.toLowerCase()}:${occurrence}`)

function ids(names: readonly string[]): string[] {
  const seen = new Map<string, number>()
  return names.map((name) => {
    const count = (seen.get(name.toLowerCase()) ?? 0) + 1
    seen.set(name.toLowerCase(), count)
    return sectionId(name, count)
  })
}

/**
 * Matches a layer file's headings to the main file's sections: by name, and
 * same-named ones in order. With one heading that matches no section and one
 * section missing from the layer in the same place, the two are paired (a rename
 * made in one file only). Returns each section's lines in the layer, and the strays.
 */
function matchLayer(names: readonly string[], layer: HeadingSplit): { matched: (string[] | null)[]; strays: HeadingSection[]; paired: { from: string; to: string } | null } {
  const queues = new Map<string, HeadingSection[]>()
  for (const section of layer.sections) {
    const key = section.name.toLowerCase()
    queues.set(key, [...(queues.get(key) ?? []), section])
  }
  const matched: (string[] | null)[] = names.map((name) => queues.get(name.toLowerCase())?.shift()?.lines ?? null)
  const left = new Set([...queues.values()].flat())
  const strays = layer.sections.filter((section) => left.has(section))
  let paired: { from: string; to: string } | null = null
  if (strays.length === 1) {
    // Where the stray is: between the matched headings before and after it in the layer.
    const at = layer.sections.indexOf(strays[0])
    const place = (section: HeadingSection | undefined) => (section ? matched.findIndex((lines) => lines === section.lines) : -1)
    const beforeSection = layer.sections.slice(0, at).reverse().find((section) => !left.has(section))
    const afterSection = layer.sections.slice(at + 1).find((section) => !left.has(section))
    const before = place(beforeSection)
    const after = afterSection ? place(afterSection) : names.length
    const missing = names.map((_name, index) => index).filter((index) => index > before && index < after && matched[index] === null)
    // A layer leaves out sections it has nothing for, so a gap is evidence of a rename only between two
    // headings it has, or when it has every section but one.
    const bounded = (beforeSection !== undefined && afterSection !== undefined) || matched.filter((lines) => lines === null).length === 1
    if (bounded && missing.length === 1) {
      matched[missing[0]] = strays[0].lines
      paired = { from: strays[0].name, to: names[missing[0]] }
      strays.length = 0
    }
  }
  return { matched, strays, paired }
}

function block(layer: string, lines: readonly string[]): string | null {
  const body = content(lines)
  return body ? `::: ${layer}\n${body}\n:::` : null
}

/**
 * The working text of a document: the preamble (the main file's, then each
 * layer's as a block), then each section as its marker, its text, and its layers'
 * blocks in the order they are declared. `layerFiles` has each declared layer's
 * file body (without frontmatter), or null when it has no file.
 */
export function assembleWorkingText(main: MainFile, layerFiles: ReadonlyMap<string, string | null>): Assembled {
  const names = main.split.sections.map((section) => section.name)
  const sectionIds = ids(names)
  const strays: StraySection[] = []
  const paired: Assembled['paired'] = []
  const perLayer = main.layers.map((layer) => {
    const body = layerFiles.get(layer.name)
    const split = body ? splitAtHeadings(body, main.level) : { preamble: [], sections: [] }
    const match = matchLayer(names, split)
    strays.push(...match.strays.map((stray) => ({ layer: layer.name, name: stray.name, lines: stray.lines })))
    if (match.paired) paired.push({ layer: layer.name, ...match.paired })
    return { name: layer.name, preamble: split.preamble, matched: match.matched }
  })

  const parts: string[] = []
  const preamble = [content(main.split.preamble), ...perLayer.map((layer) => block(layer.name, layer.preamble))].filter((part): part is string => Boolean(part))
  if (preamble.length > 0) parts.push(preamble.join('\n\n'))
  const sections: AssembledSection[] = main.split.sections.map((section, index) => {
    const own = main.fields[section.name] ?? {}
    const heading = own.heading !== false
    const fields = Object.fromEntries(Object.entries(own).filter(([key]) => key !== 'heading'))
    const body = [content(section.lines), ...perLayer.map((layer) => block(layer.name, layer.matched[index] ?? []))].filter((part): part is string => Boolean(part))
    const marker = sectionMarkerLine(section.name, { id: sectionIds[index], heading })
    parts.push(body.length > 0 ? `${marker}\n${body.join('\n\n')}` : marker)
    return { id: sectionIds[index], name: section.name, heading, fields }
  })
  const lower = new Set(names.map((name) => name.toLowerCase()))
  const orphanFields = Object.keys(main.fields).filter((name) => !lower.has(name.toLowerCase()))
  return { text: parts.join('\n'), sections, strays, paired, orphanFields }
}

// ---------------------------------------------------------------------------
// Working text to files

export interface WorkingSection {
  /** The marker's id; null when it has none (typed in by hand). */
  id: string | null
  name: string
  heading: boolean
  /** The section's text, without its marker and layer blocks. */
  text: string[]
  /** Each layer's contents, its blocks joined with a blank line. */
  layers: Record<string, string[]>
}

export interface WorkingText {
  preamble: { text: string[]; layers: Record<string, string[]> }
  sections: WorkingSection[]
}

/** Splits the editor's working text into the preamble and sections, each with its text and its layers. */
export function splitWorkingText(text: string, layers: readonly string[]): WorkingText {
  const lines = text.split('\n')
  const roles = classifyBlocks(lines, layers)
  const markers = extractSectionMarkers(text, layers)
  const region = (from: number, to: number) => {
    const own: string[] = []
    const perLayer: Record<string, string[]> = {}
    let removed = false
    for (let index = from; index < to; index += 1) {
      const { role, layer } = roles[index]
      const line = lines[index].replace(/\r$/, '')
      if (role === 'output') {
        // A block taken out from between two blank lines leaves one of them.
        if (removed && line.trim() === '' && own.length > 0 && own[own.length - 1].trim() === '') {
          removed = false
          continue
        }
        removed = false
        own.push(line)
        continue
      }
      removed = true
      if (role === 'open') {
        const list = (perLayer[layer!] ??= [])
        if (list.length > 0) list.push('')
      } else if (role === 'notes') {
        perLayer[layer!].push(line)
      }
    }
    for (const name of Object.keys(perLayer)) perLayer[name] = trimLines(perLayer[name])
    return { text: trimLines(own), layers: perLayer }
  }
  const first = markers[0]?.line ?? lines.length + 1
  return {
    preamble: region(0, first - 1),
    sections: markers.map((marker, index) => {
      const own = region(marker.line, (markers[index + 1]?.line ?? lines.length + 1) - 1)
      return { id: marker.id, name: marker.name, heading: marker.heading, ...own }
    }),
  }
}

/** A body: the preamble, then each section under its heading. Sections are separated by one blank line. */
export function writeBody(level: number, preamble: readonly string[], sections: readonly { name: string; lines: readonly string[] }[]): string {
  const hashes = '#'.repeat(level)
  const parts: string[] = []
  const lead = content(preamble)
  if (lead) parts.push(lead)
  for (const section of sections) {
    const body = content(section.lines)
    parts.push(body ? `${hashes} ${section.name}\n\n${body}` : `${hashes} ${section.name}`)
  }
  return parts.length > 0 ? `${parts.join('\n\n')}\n` : ''
}

/** What a body holds, to tell whether writing it again would change anything but its spacing. */
export function bodyKey(body: string, level: number, ordered: boolean): string {
  const split = splitAtHeadings(body, level)
  const sections = split.sections.map((section) => `${section.name}\u0000${content(section.lines)}`)
  if (!ordered) sections.sort()
  return [content(split.preamble), ...sections].join('\u0001')
}

/** The YAML value for a layer, as written in the main file. */
function declarationValue(layer: LayerDeclaration): Record<string, unknown> {
  return layer.file ? { name: layer.name, kind: layer.kind, file: layer.file } : { name: layer.name, kind: layer.kind }
}

const sameValue = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)

/**
 * The main file's frontmatter with new layers or section fields, keeping its
 * comments and other keys. A value that is unchanged is not touched.
 */
export function writeMainYaml(yaml: string | null, change: { layers?: readonly LayerDeclaration[]; fields?: Record<string, Record<string, unknown>>; level?: number }): string {
  const current = readFields(yaml)
  const next = editFields(yaml, (doc) => {
    if (current.verdandi !== 'document') doc.set('verdandi', 'document')
    if (change.level !== undefined && change.level !== (current['section-level'] ?? DEFAULT_SECTION_LEVEL)) {
      if (change.level === DEFAULT_SECTION_LEVEL) doc.delete('section-level')
      else doc.set('section-level', change.level)
    }
    if (change.layers) {
      const values = change.layers.map(declarationValue)
      const written = parseDeclarations(current.layers).map(declarationValue)
      // `anchored` is from the earlier format: layer files have no paragraphs to anchor to.
      const anchored = Array.isArray(current.layers) && current.layers.some((item) => item && typeof item === 'object' && 'anchored' in item)
      if (anchored || !sameValue(values, written) || (values.length === 0) !== (current.layers === undefined)) {
        if (values.length === 0) doc.delete('layers')
        else {
          const node = doc.createNode(values)
          if (isSeq(node)) for (const item of node.items) if (isMap(item)) item.flow = true
          doc.set('layers', node)
        }
      }
    }
    if (change.fields) {
      const entries = Object.entries(change.fields).filter(([, value]) => Object.keys(value).length > 0)
      if (!sameValue(Object.fromEntries(entries), parseSectionFields(current.sections))) {
        if (entries.length === 0) doc.delete('sections')
        else {
          const node = doc.createNode(Object.fromEntries(entries))
          if (isMap(node)) for (const pair of node.items) if (isMap(pair.value)) pair.value.flow = true
          doc.set('sections', node)
        }
      }
    }
  })
  return next ?? 'verdandi: document\n'
}

/**
 * Gives the working text's sections names that are unique: a section that kept
 * the name and id it was read with keeps its name (two read with the same name
 * stay that way); any other that repeats a name gets " (2)", " (3)" ….
 */
export function uniqueSectionNames(sections: readonly Pick<WorkingSection, 'id' | 'name'>[], known: ReadonlyMap<string, string>): string[] {
  const keeps = (section: Pick<WorkingSection, 'id' | 'name'>) => section.id !== null && known.get(section.id) === section.name
  // Sections read from the files first, so a new one never takes their names.
  const taken = new Set(sections.filter(keeps).map((section) => section.name.toLowerCase()))
  return sections.map((section) => {
    if (keeps(section)) return section.name
    let name = section.name.trim() || 'Untitled'
    if (taken.has(name.toLowerCase())) {
      const base = name.replace(/ \(\d+\)$/, '')
      let count = 2
      while (taken.has(`${base} (${count})`.toLowerCase())) count += 1
      name = `${base} (${count})`
    }
    taken.add(name.toLowerCase())
    return name
  })
}
