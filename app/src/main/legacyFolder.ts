import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { parse as parseYaml } from 'yaml'

import type { TextDocument, TextFormat } from '../shared/ipc'
import { layerFileName, splitAtHeadings, splitWorkingText } from '../shared/layerFiles'
import { assembleSection, type Layer, parseDocumentNote, parseSectionFile, type SectionFile, sectionFields, splitFrontmatter, stableId } from '../shared/layers'
import { documentNoteOf, readTextDocument } from './fileService'
import { CONVERTED_DIR, planFiles } from './layerDocument'
import { encodeText } from './textFile'

// Folder documents in the earlier format (PLAN.md §3b): a folder with a document
// note named after it, listing its sections as embeds, and one Markdown file per
// section with its other layers as callouts. They are read here to convert them to
// layer files (§3c) when opened, and read only for search and stats until then.

const exists = (target: string) => stat(target).then(() => true, () => false)

// ---------------------------------------------------------------------------
// Reading

interface LoadedSection {
  id: string
  /** The file's name without `.md`. */
  base: string
  file: string
  parsed: SectionFile
  raw: string
  format: TextFormat
  /** The section's name: the title in its frontmatter, or its file name. */
  name: string
  /** The section's lines in the editor's text, to tell whether it changed. */
  segment: string
}

interface LoadedFolder {
  folder: string
  note: TextDocument
  declared: Layer[]
  layers: string[]
  sections: LoadedSection[]
  /** Stands in for an mtime: changes whenever any of the document's files does. */
  token: number
  size: number
  /** The latest mtime of the document's files. */
  modifiedMs: number
  text: string
}

/** A number that changes when any of `parts` does (FNV-1a), never zero. */
function tokenOf(parts: readonly string[]): number {
  let hash = 0x811c9dc5
  for (const char of parts.join('\u0000')) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash || 1
}

async function loadFolder(folder: string): Promise<LoadedFolder> {
  const noteFile = await documentNoteOf(folder)
  if (!noteFile) throw new Error(`${path.basename(folder)} is not a document folder.`)
  const note = await readTextDocument(noteFile)
  const parsed = parseDocumentNote(note.text)
  const layers = parsed.layers.map((layer) => layer.name)
  const names = new Map((await readdir(folder)).map((name) => [name.toLowerCase(), name]))
  const recovered = await recoverStale(folder, noteFile, parsed.sections, names, layers)
  const sections: LoadedSection[] = []
  const seen = new Set<string>()
  const ids = new Set<string>()
  for (const target of parsed.sections) {
    // Obsidian matches links without regard to case.
    const actual = names.get(`${target}.md`.toLowerCase()) ?? recovered.get(target)
    if (!actual || target.includes('/') || target.includes('\\')) continue
    const file = path.join(folder, actual)
    if (seen.has(file.toLowerCase()) || file.toLowerCase() === noteFile.toLowerCase()) continue
    seen.add(file.toLowerCase())
    const document = await readTextDocument(file).catch(() => null)
    if (!document) continue
    const base = actual.replace(/\.md$/i, '')
    const sectionFile = parseSectionFile(document.text, layers)
    // A file without an id (made in Obsidian) gets one from its name, the same every time it is read.
    let id = sectionFile.id ?? stableId(`file:${base.toLowerCase()}`)
    if (ids.has(id)) id = stableId(`copy:${base.toLowerCase()}`)
    ids.add(id)
    const name = sectionFile.title ?? base
    const segment = assembleSection({ id, name, heading: sectionFile.heading, text: sectionFile.text })
    sections.push({ id, base, file, parsed: sectionFile, raw: document.text, format: document.format, name, segment })
  }
  const stamps = await Promise.all([noteFile, ...sections.map((section) => section.file)].map(async (file) => {
    const info = await stat(file).catch(() => null)
    return { file, mtime: info?.mtimeMs ?? 0, size: info?.size ?? 0 }
  }))
  return {
    folder,
    note,
    declared: parsed.layers,
    layers,
    sections,
    token: tokenOf(stamps.map((stamp) => `${stamp.file}:${stamp.mtime}`)),
    size: stamps.reduce((sum, stamp) => sum + stamp.size, 0),
    modifiedMs: Math.max(...stamps.map((stamp) => stamp.mtime)),
    text: sections.map((section) => section.segment).join('\n'),
  }
}

/** A document folder in the earlier format as one text, read only (for search and stats before it is opened). */
export async function readFolderDocument(folder: string): Promise<TextDocument> {
  const loaded = await loadFolder(folder)
  return {
    path: folder, text: loaded.text, format: loaded.note.format, mtimeMs: loaded.token, size: loaded.size, folder: true, layers: loaded.declared, modifiedMs: loaded.modifiedMs,
    fields: Object.fromEntries(loaded.sections.map((section) => [section.id, sectionFields(section.parsed.yaml)])),
  }
}

// ---------------------------------------------------------------------------
// Finding sections again

/** Where a document folder remembers which file each section was in, by id. */
export const SECTIONS_FILE = path.join('.verdandi', 'sections.yaml')

async function rememberedFiles(folder: string): Promise<Map<string, string>> {
  const text = await readFile(path.join(folder, SECTIONS_FILE), 'utf8').catch(() => null)
  if (text === null) return new Map()
  let data: unknown
  try {
    data = parseYaml(text)
  } catch {
    return new Map()
  }
  const files = new Map<string, string>()
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const [id, base] of Object.entries(data as Record<string, unknown>)) {
      if (typeof base === 'string') files.set(base.toLowerCase(), String(id))
    }
  }
  return files
}

/**
 * Embeds in the document note whose file is gone, matched to section files in the
 * folder that no embed lists: by the id remembered for the embed's name, or, with
 * one stale embed and one such file, to each other. Returns the file name for each
 * stale embed that was found.
 */
async function recoverStale(
  folder: string, noteFile: string, targets: readonly string[], names: ReadonlyMap<string, string>, layers: readonly string[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  const stale = targets.filter((target) => !names.has(`${target}.md`.toLowerCase()) && !target.includes('/') && !target.includes('\\'))
  if (stale.length === 0) return found
  const listed = new Set(targets.map((target) => `${target}.md`.toLowerCase()))
  const orphans: { name: string; id: string }[] = []
  for (const [lower, name] of names) {
    if (!lower.endsWith('.md') || listed.has(lower) || lower === path.basename(noteFile).toLowerCase()) continue
    const text = await readFile(path.join(folder, name), 'utf8').catch(() => null)
    const id = text === null ? null : parseSectionFile(text, layers).id
    if (id) orphans.push({ name, id })
  }
  if (orphans.length === 0) return found
  const remembered = await rememberedFiles(folder)
  const used = new Set<string>()
  for (const target of stale) {
    const id = remembered.get(target.toLowerCase())
    const orphan = id ? orphans.find((candidate) => candidate.id === id && !used.has(candidate.name)) : undefined
    if (orphan) {
      found.set(target, orphan.name)
      used.add(orphan.name)
    }
  }
  const left = orphans.filter((orphan) => !used.has(orphan.name))
  const unmatched = stale.filter((target) => !found.has(target))
  if (unmatched.length === 1 && left.length === 1) found.set(unmatched[0], left[0].name)
  return found
}


// ---------------------------------------------------------------------------
// Converting to layer files

/** The heading level for sections that no text or layer in the document already uses, so converting never splits a section. */
function freeLevel(text: string, layers: readonly string[]): number {
  const working = splitWorkingText(text, layers)
  const bodies = [working.preamble, ...working.sections].flatMap((part) => [part.text, ...Object.values(part.layers)]).map((lines) => lines.join('\n'))
  return [2, 1, 3, 4, 5, 6].find((level) => bodies.every((body) => splitAtHeadings(body, level).sections.length === 0)) ?? 2
}

/**
 * Converts a document folder in the earlier format to layer files (§3c): the
 * sections' text becomes the main file, each layer its own file, and the sections'
 * fields go under `sections`. The earlier files move to `.verdandi/converted/`,
 * where they stay. Anchored notes join the end of their section's notes.
 */
export async function convertLegacyFolder(folder: string): Promise<void> {
  const loaded = await loadFolder(folder)
  const layers = loaded.declared.map(({ name, kind }) => ({ name, kind, anchored: false }))
  const level = freeLevel(loaded.text, loaded.layers)
  const plan = planFiles(loaded.text, {
    level,
    layers,
    mainYaml: splitFrontmatter(loaded.note.text).yaml,
    mainBody: null,
    layerFiles: new Map(),
    known: loaded.sections.map((section) => ({ id: section.id, name: section.name, fields: sectionFields(section.parsed.yaml) })),
    strays: [],
    orphans: {},
  })
  const base = path.basename(loaded.note.path).replace(/\.md$/i, '')
  const written = [
    { file: loaded.note.path, text: plan.main ?? '' },
    ...layers.flatMap((layer) => {
      const text = plan.layers.get(layer.name)
      return text ? [{ file: path.join(folder, layerFileName(base, layer)), text }] : []
    }),
  ]

  const converted = path.join(folder, CONVERTED_DIR)
  await mkdir(converted, { recursive: true })
  // Files already where layer files go (left by hand, say) are kept with the earlier ones rather than written over.
  const moves = [loaded.note.path, ...loaded.sections.map((section) => section.file), path.join(folder, SECTIONS_FILE), ...written.slice(1).map((entry) => entry.file)]
  const moved: { from: string; to: string }[] = []
  const format: TextFormat = { encoding: 'utf-8', eol: loaded.note.format.eol, mixedEol: false }
  const created: string[] = []
  try {
    for (const from of moves) {
      if (!(await exists(from))) continue
      let to = path.join(converted, path.basename(from))
      if (await exists(to)) to = path.join(converted, `${randomBytes(3).toString('hex')} ${path.basename(from)}`)
      await rename(from, to)
      moved.push({ from, to })
    }
    for (const entry of written) {
      await writeFile(entry.file, encodeText(entry.text, format).bytes, { flag: 'wx' })
      created.push(entry.file)
    }
  } catch (error) {
    for (const file of created) await rm(file, { force: true }).catch(() => {})
    for (const move of moved.reverse()) await rename(move.to, move.from).catch(() => {})
    throw error
  }
}

/** Whether a document folder is in the earlier format: its note embeds section files that are in the folder. */
export async function isLegacyFolder(folder: string): Promise<boolean> {
  const note = await documentNoteOf(folder)
  if (!note) return false
  const targets = parseDocumentNote((await readTextDocument(note)).text).sections
  if (targets.length === 0) return false
  const names = new Set((await readdir(folder)).map((name) => name.toLowerCase()))
  return targets.some((target) => names.has(`${target}.md`.toLowerCase()))
}
