import { randomBytes } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { TextDocument, TextFormat, WriteRequest, WriteResult } from '../shared/ipc'
import {
  assembleSection, convertOneFile, type DisassembledSection, disassembleDocument, fileNameFor, INTRODUCTION,
  joinFrontmatter, type Layer, type LayerChange, layerNameError, LAYER_KINDS, newDocumentNote, newSectionId, NOTES_LAYER, parseDocumentNote, parseSectionFile, type SectionFile, setFields,
  removeLayerBlocks, renameLayerBlocks, sectionFields, stableId, tidySectionText, uniqueName, writeDocumentNote, writeSectionFile,
} from '../shared/layers'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import { normalizeView, parseViews, type SavedView, VIEWS_FILE, writeViews } from '../shared/views'
import { sectionMarkerLine } from '../shared/text'
import { type BackupStore, documentNoteOf, readTextDocument, writeTextDocument } from './fileService'
import { encodeText } from './textFile'

// Folder documents (PLAN.md §3b): a folder with a document note named after it and
// one Markdown file per section. The editor sees one text (see `assembleDocument`);
// saving splits it back and writes only the files whose section changed.

/** Where a converted document keeps the one-file original, inside its folder. */
export const ORIGINAL_DIR = path.join('.verdandi', 'original')

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

/** A document folder as one text, for the editor. */
export async function readFolderDocument(folder: string): Promise<TextDocument> {
  const loaded = await loadFolder(folder)
  return {
    path: folder, text: loaded.text, format: loaded.note.format, mtimeMs: loaded.token, size: loaded.size, folder: true, layers: loaded.declared, modifiedMs: loaded.modifiedMs,
    fields: Object.fromEntries(loaded.sections.map((section) => [section.id, sectionFields(section.parsed.yaml)])),
  }
}

/** Reads a document: a text file, or a document folder as one text. */
export async function readDocument(target: string, allowMissing = false): Promise<TextDocument> {
  const info = await stat(target).catch(() => null)
  if (info?.isDirectory() && (await documentNoteOf(target))) return readFolderDocument(target)
  return readTextDocument(target, allowMissing)
}

/** Whether `target` is a document folder. */
export async function isFolderDocument(target: string): Promise<boolean> {
  const info = await stat(target).catch(() => null)
  return Boolean(info?.isDirectory() && (await documentNoteOf(target)))
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
 * Records which file each section is in, so that a section file renamed outside
 * Obsidian (which would have updated the embed) can be found again by its id. Only
 * written when it changed. Best effort: a folder that can't be written still works.
 */
async function rememberSections(loaded: LoadedFolder): Promise<void> {
  const file = path.join(loaded.folder, SECTIONS_FILE)
  const ids = Object.fromEntries(loaded.sections.filter((section) => section.parsed.id === section.id).map((section) => [section.id, section.base]))
  const text = `# The file each section was in when Verdandi last saved, by id, to find a section again if its file is renamed.\n${stringifyYaml(ids, { lineWidth: 0 })}`
  if ((await readFile(file, 'utf8').catch(() => null)) === text) return
  try {
    await mkdir(path.dirname(file), { recursive: true })
    const temporary = `${file}.${randomBytes(4).toString('hex')}.tmp`
    await writeFile(temporary, text, 'utf8')
    await rename(temporary, file)
  } catch {
    // see above
  }
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
// Writing

interface Planned {
  section: DisassembledSection
  existing: LoadedSection | undefined
  id: string
  base: string
}

/**
 * Saves the editor's text of a document folder. Sections are matched to files by
 * the ids in their markers: a section whose lines are unchanged is not touched; a
 * changed one is written (and its file renamed if its name changed); a new one gets
 * a file; a section that is gone has its file moved to the trash. The document note
 * is rewritten only if the order or the file names changed.
 *
 * `text` in the result is the editor's text with ids given to sections that had
 * none, when there were any.
 */
export async function writeFolderDocument(
  folder: string,
  request: WriteRequest,
  backups: BackupStore,
  trash: (target: string) => Promise<void>,
): Promise<WriteResult & { text?: string }> {
  const current = await loadFolder(folder)
  if (!request.force && request.expectedMtimeMs !== current.token) {
    return { ok: false, reason: 'conflict', diskMtimeMs: current.token }
  }
  const wanted = disassembleDocument(request.text, current.layers)
  const byId = new Map(current.sections.map((section) => [section.id, section]))

  // Ids: a section keeps its file; a copied marker or a new section gets an id of its
  // own, made from its name so that saving again before the editor has it gives the same one.
  const used = new Set<string>()
  const occurrences = new Map<string, number>()
  const plans: Omit<Planned, 'base'>[] = wanted.map((section) => {
    let existing = section.id ? byId.get(section.id) : undefined
    if (existing && used.has(existing.id)) existing = undefined
    let id = existing?.id ?? section.id
    if (!id || used.has(id)) {
      const count = (occurrences.get(section.name) ?? 0) + 1
      occurrences.set(section.name, count)
      id = stableId(`new:${section.name}:${count}`)
      while (used.has(id)) id = stableId(`${id}+`)
    }
    used.add(id)
    return { section, existing, id }
  })

  // File names: a section whose name did not change keeps its file's name.
  const noteBase = path.basename(current.note.path).replace(/\.md$/i, '')
  const ownFiles = new Set(current.sections.map((section) => `${section.base}.md`.toLowerCase()))
  const taken = new Set([noteBase.toLowerCase()])
  for (const name of await readdir(folder)) {
    if (!ownFiles.has(name.toLowerCase()) && /\.md$/i.test(name)) taken.add(name.replace(/\.md$/i, '').toLowerCase())
  }
  const kept = plans.map((plan) => (plan.existing && plan.existing.name === plan.section.name ? plan.existing.base : null))
  for (const base of kept) if (base) taken.add(base.toLowerCase())
  const planned: Planned[] = plans.map((plan, index) => ({ ...plan, base: kept[index] ?? uniqueName(fileNameFor(plan.section.name), taken) }))

  const removed = current.sections.filter((section) => !used.has(section.id))
  for (const section of removed) {
    await backups.ensureBackup(section.file)
    await trash(section.file)
  }

  // Renames go through temporary names, so two sections can swap names.
  const renames = planned.filter((plan) => plan.existing && plan.existing.base !== plan.base)
  const parked = new Map<Planned, string>()
  for (const plan of renames) {
    const temporary = path.join(folder, `.${plan.base}.verdandi-${randomBytes(4).toString('hex')}.tmp`)
    await backups.ensureBackup(plan.existing!.file)
    await rename(plan.existing!.file, temporary)
    parked.set(plan, temporary)
  }
  for (const [plan, temporary] of parked) await rename(temporary, path.join(folder, `${plan.base}.md`))

  for (const plan of planned) {
    const { section, existing } = plan
    const target = path.join(folder, `${plan.base}.md`)
    const renamed = existing !== undefined && existing.base !== plan.base
    const idChanged = existing === undefined || existing.parsed.id !== plan.id
    if (existing && !renamed && section.segment === existing.segment) continue
    const yaml = setFields(existing?.parsed.yaml ?? null, {
      ...(idChanged ? { id: plan.id } : {}),
      title: section.name === plan.base ? undefined : section.name,
      heading: section.heading ? undefined : false,
    })
    // Only renamed, or only its heading switched: the text stays exactly as it was.
    const sameText = existing !== undefined && withoutFinalBreak(existing.parsed.text) === withoutFinalBreak(section.text)
    const text = sameText ? existing.parsed.text : tidySectionText(section.text)
    const content = writeSectionFile({ yaml, text }, current.layers)
    if (existing && content === existing.raw) continue
    const format = existing?.format ?? current.note.format
    const result = await writeTextDocument(target, { path: target, text: content, format, expectedMtimeMs: null, force: true }, backups)
    if (!result.ok) throw new Error(`Couldn’t write ${plan.base}.md.`)
  }

  const note = writeDocumentNote(current.note.text, { sections: planned.map((plan) => plan.base) })
  if (note !== current.note.text) {
    const result = await writeTextDocument(current.note.path, { path: current.note.path, text: note, format: current.note.format, expectedMtimeMs: null, force: true }, backups)
    if (!result.ok) throw new Error(`Couldn’t write ${path.basename(current.note.path)}.`)
  }

  const saved = await loadFolder(folder)
  await rememberSections(saved)
  const result: WriteResult & { text?: string } = { ok: true, mtimeMs: saved.token, size: saved.size, format: saved.note.format, notice: null }
  const fresh = planned.filter((plan) => plan.section.id !== plan.id)
  if (fresh.length > 0) result.text = withIds(request.text, planned)
  return result
}

const withoutFinalBreak = (text: string) => (text.endsWith('\n') ? text.slice(0, -1) : text)

/** The editor's text with each section's marker carrying its id. */
function withIds(text: string, planned: readonly Planned[]): string {
  const lines = text.split('\n')
  let preamble: string | null = null
  for (const { section, id } of planned) {
    const marker = sectionMarkerLine(section.name, { id, heading: section.heading })
    if (section.line > 0) lines[section.line - 1] = marker
    else preamble = marker // text before the first marker gets a marker of its own
  }
  if (preamble !== null) lines.unshift(preamble)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Layers and views

/**
 * Changes the document's layers. Adding one only declares it (an empty layer is not
 * written); renaming rewrites its callouts in every section file that has any;
 * deleting removes them. The section files go first and the document note last, so
 * an interrupted change leaves blocks that are still declared or plain callouts, and
 * never loses text.
 */
export async function changeLayers(folder: string, change: LayerChange, backups: BackupStore): Promise<void> {
  const current = await loadFolder(folder)
  let next = current.declared
  let rewrite: ((text: string) => string) | null = null
  const find = (name: unknown) => {
    const layer = typeof name === 'string' ? next.find((candidate) => candidate.name === name) : undefined
    if (!layer) throw new Error(`The document has no layer called “${String(name)}”.`)
    return layer
  }
  if ('add' in change) {
    const name = String(change.add?.name ?? '').trim().toLowerCase()
    const error = layerNameError(name, next)
    if (error) throw new Error(error)
    const kind = LAYER_KINDS.includes(change.add.kind) ? change.add.kind : 'prose'
    next = [...next, { name, kind, anchored: change.add.anchored === true }]
  } else if ('rename' in change) {
    const layer = find(change.rename)
    const to = String(change.to ?? '').trim().toLowerCase()
    if (to === layer.name) return
    const error = layerNameError(to, next, layer.name)
    if (error) throw new Error(error)
    next = next.map((candidate) => (candidate === layer ? { ...candidate, name: to } : candidate))
    rewrite = (text) => renameLayerBlocks(text, current.layers, layer.name, to)
  } else if ('remove' in change) {
    const layer = find(change.remove)
    next = next.filter((candidate) => candidate !== layer)
    rewrite = (text) => removeLayerBlocks(text, current.layers, layer.name)
  } else if ('change' in change) {
    const layer = find(change.change)
    const kind = change.kind && LAYER_KINDS.includes(change.kind) ? change.kind : layer.kind
    next = next.map((candidate) => (candidate === layer ? { ...candidate, kind, anchored: change.anchored ?? candidate.anchored } : candidate))
  } else {
    throw new TypeError('Unknown layer change.')
  }
  const names = next.map((layer) => layer.name)
  if (rewrite) {
    for (const section of current.sections) {
      const text = rewrite(section.parsed.text)
      if (text === section.parsed.text) continue
      const content = writeSectionFile({ yaml: section.parsed.yaml, text }, names)
      const result = await writeTextDocument(section.file, { path: section.file, text: content, format: section.format, expectedMtimeMs: null, force: true }, backups)
      if (!result.ok) throw new Error(`Couldn’t write ${section.base}.md.`)
    }
  }
  const note = writeDocumentNote(current.note.text, { layers: next })
  if (note !== current.note.text) {
    const result = await writeTextDocument(current.note.path, { path: current.note.path, text: note, format: current.note.format, expectedMtimeMs: null, force: true }, backups)
    if (!result.ok) throw new Error(`Couldn’t write ${path.basename(current.note.path)}.`)
  }
}

const viewsFile = (folder: string) => path.join(folder, '.verdandi', VIEWS_FILE)

/** A document folder's saved views; none when it has no `views.yaml`. */
export async function readViews(folder: string): Promise<SavedView[]> {
  const { layers } = await loadFolder(folder)
  const text = await readFile(viewsFile(folder), 'utf8').catch(() => null)
  return text === null ? [] : parseViews(text, layers)
}

/** Writes a document folder's saved views; with none left, the file goes. */
export async function saveViews(folder: string, views: unknown): Promise<void> {
  if (!Array.isArray(views)) throw new TypeError('views must be a list')
  const { layers } = await loadFolder(folder)
  const clean: SavedView[] = []
  for (const view of views) {
    const name = view && typeof view === 'object' && typeof (view as { name?: unknown }).name === 'string' ? (view as { name: string }).name.trim() : ''
    if (name && !clean.some((saved) => saved.name === name)) clean.push({ name, ...normalizeView(view, layers) })
  }
  const file = viewsFile(folder)
  if (clean.length === 0) {
    await rm(file, { force: true })
    return
  }
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(temporary, writeViews(clean), 'utf8')
  await rename(temporary, file)
}

// ---------------------------------------------------------------------------
// Images

/** Where a document folder keeps its images, as Obsidian does. */
export const ATTACHMENTS_DIR = 'attachments'
export const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|svg|avif|bmp)$/i

/**
 * Copies image files into the document folder's `attachments/` and returns the
 * names they were saved under: a file's own name, or "name 2.png" when that is
 * taken. Anything that is not an image file is skipped.
 */
export async function addAttachments(folder: string, sources: readonly string[]): Promise<string[]> {
  if (!(await isFolderDocument(folder))) throw new Error(`${path.basename(folder)} is not a document folder.`)
  const target = path.join(folder, ATTACHMENTS_DIR)
  await mkdir(target, { recursive: true })
  const taken = new Set((await readdir(target)).map((name) => name.toLowerCase()))
  const saved: string[] = []
  for (const source of sources) {
    if (!IMAGE_FILE.test(source)) continue
    const info = await stat(source).catch(() => null)
    if (!info?.isFile()) continue
    const extension = path.extname(source)
    const base = path.basename(source, extension).replace(/[[\]|#^]/g, ' ').trim() || 'image'
    let name = `${base}${extension}`
    for (let count = 2; taken.has(name.toLowerCase()); count += 1) name = `${base} ${count}${extension}`
    await copyFile(source, path.join(target, name), fsConstants.COPYFILE_EXCL)
    taken.add(name.toLowerCase())
    saved.push(name)
  }
  return saved
}

// ---------------------------------------------------------------------------
// Creating, renaming, deleting

function introduction(id: string): string {
  return joinFrontmatter(setFields(null, { id, heading: false }), '')
}

/** Makes a new document folder with one empty section and returns its path. */
export async function createFolderDocument(parent: string, name: string, newId: () => string = newSectionId): Promise<string> {
  const folder = path.join(parent, name)
  if (await exists(folder)) throw new Error(`“${name}” already exists here.`)
  if (await exists(`${folder}.md`)) throw new Error(`“${name}.md” already exists here.`)
  const format = { encoding: 'utf-8', eol: '\n', mixedEol: false } as const
  const section = name.toLowerCase() === INTRODUCTION.toLowerCase() ? `${INTRODUCTION} 2` : INTRODUCTION
  await mkdir(folder)
  try {
    await writeFile(path.join(folder, `${name}.md`), encodeText(newDocumentNote([NOTES_LAYER], [section]), format).bytes, { flag: 'wx' })
    await writeFile(path.join(folder, `${section}.md`), encodeText(introduction(newId()), format).bytes, { flag: 'wx' })
  } catch (error) {
    await rm(folder, { recursive: true, force: true })
    throw error
  }
  await rememberSections(await loadFolder(folder))
  return folder
}

/** Renames a document folder and its document note together, and returns the new path. */
export async function renameFolderDocument(folder: string, name: string): Promise<string> {
  const target = path.join(path.dirname(folder), name)
  if (path.basename(folder) === name) return folder
  if (target.toLowerCase() !== folder.toLowerCase() && (await exists(target))) throw new Error(`“${name}” already exists here.`)
  const note = await documentNoteOf(folder)
  if (!note) throw new Error(`${path.basename(folder)} is not a document folder.`)
  const renamedNote = path.join(folder, `${name}.md`)
  if (renamedNote.toLowerCase() !== note.toLowerCase() && (await exists(renamedNote))) {
    throw new Error(`The folder already has a file called “${name}.md”.`)
  }
  await rename(note, renamedNote)
  try {
    await rename(folder, target)
  } catch (error) {
    await rename(renamedNote, note).catch(() => {})
    throw error
  }
  return target
}

export interface TrashedFolder {
  path: string
  files: { relative: string; bytes: Buffer }[]
}

async function collect(folder: string, relative = ''): Promise<TrashedFolder['files']> {
  const files: TrashedFolder['files'] = []
  for (const entry of await readdir(path.join(folder, relative), { withFileTypes: true })) {
    const inner = path.join(relative, entry.name)
    if (entry.isDirectory()) files.push(...(await collect(folder, inner)))
    else if (entry.isFile()) files.push({ relative: inner, bytes: await readFile(path.join(folder, inner)) })
  }
  return files
}

/** Moves a document folder to the trash, keeping its files so the deletion can be undone. */
export async function trashFolderDocument(folder: string, trash: (target: string) => Promise<void>): Promise<TrashedFolder> {
  const files = await collect(folder)
  await trash(folder)
  return { path: folder, files }
}

export async function restoreFolderDocument(entry: TrashedFolder): Promise<void> {
  if (await exists(entry.path)) throw new Error(`“${path.basename(entry.path)}” exists again, so nothing was restored.`)
  for (const file of entry.files) {
    const target = path.join(entry.path, file.relative)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, file.bytes, { flag: 'wx' })
  }
}

// ---------------------------------------------------------------------------
// Converting a one-file document

export interface ConvertedFolder {
  /** The new document folder. */
  folder: string
  /** The document note inside it, named after the folder. */
  note: string
  /** Where the original file now is. */
  original: string
}

/**
 * Turns a one-file document into a document folder next to it (PLAN.md §3b): a
 * document note, one file per section, and the original file kept in
 * `.verdandi/original/` so the conversion can be undone. Everything is written to
 * a hidden folder first and renamed into place last, so a failure leaves the
 * original where it was.
 */
export async function convertFileToFolder(file: string, newId: () => string = newSectionId): Promise<ConvertedFolder> {
  const source = await readTextDocument(file)
  const parent = path.dirname(file)
  const fileName = path.basename(file)
  const base = path.basename(file, path.extname(file)) || fileName
  // An extensionless file has its folder's name: that name is free once the file moves.
  let name = base
  for (let count = 2; ; count += 1) {
    const candidate = path.join(parent, name)
    if (candidate === file || !(await exists(candidate))) break
    name = `${base} ${count}`
  }

  const converted = convertOneFile(source.text, name, newId)
  const format = { encoding: 'utf-8', eol: source.format.eol, mixedEol: false } as const
  const write = (target: string, text: string) => writeFile(target, encodeText(text, format).bytes, { flag: 'wx' })

  const staging = path.join(parent, `.${name}.verdandi-${randomBytes(4).toString('hex')}`)
  await mkdir(path.join(staging, ORIGINAL_DIR), { recursive: true })
  try {
    await write(path.join(staging, `${name}.md`), converted.note)
    for (const section of converted.sections) await write(path.join(staging, `${section.name}.md`), section.text)
    await rename(file, path.join(staging, ORIGINAL_DIR, fileName))
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
  const folder = path.join(parent, name)
  try {
    await rename(staging, folder)
  } catch (error) {
    await rename(path.join(staging, ORIGINAL_DIR, fileName), file).catch(() => {})
    await rm(staging, { recursive: true, force: true })
    throw error
  }
  await loadFolder(folder).then(rememberSections, () => {})
  return { folder, note: path.join(folder, `${name}.md`), original: path.join(folder, ORIGINAL_DIR, fileName) }
}

/**
 * Undoes a conversion: puts the original file back next to the folder and moves
 * the folder, with any edits made since, to the trash. Returns the file's path.
 */
export async function undoConversion(folder: string, trash: (target: string) => Promise<void>): Promise<string> {
  const originals = await readdir(path.join(folder, ORIGINAL_DIR)).catch(() => [] as string[])
  if (originals.length !== 1) throw new Error('This folder was not converted from a single file, so there is nothing to undo.')
  const file = path.join(path.dirname(folder), originals[0])
  if (file !== folder && (await exists(file))) throw new Error(`${originals[0]} already exists next to the folder.`)
  if (file !== folder) {
    await rename(path.join(folder, ORIGINAL_DIR, originals[0]), file)
    await trash(folder)
    return file
  }
  // An extensionless original has the folder's own name, so the folder moves aside first.
  const parked = path.join(path.dirname(folder), `.${path.basename(folder)}.verdandi-undo-${randomBytes(4).toString('hex')}`)
  await rename(folder, parked)
  await rename(path.join(parked, ORIGINAL_DIR, originals[0]), file)
  await trash(parked)
  return file
}

