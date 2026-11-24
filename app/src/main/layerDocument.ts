import { randomBytes } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { TextDocument, TextFormat, WriteRequest, WriteResult } from '../shared/ipc'
import {
  assembleWorkingText, type Assembled, bodyKey, DEFAULT_SECTION_LEVEL, discoverLayers, hasDefaultFile, layerFileName, type LayerDeclaration, type MainFile, parseMainFile, sectionId,
  splitWorkingText, type StraySection, uniqueSectionNames, writeBody, writeMainYaml,
} from '../shared/layerFiles'
import {
  type FieldChange, FrontmatterError, INTRODUCTION, isOwnField, joinFrontmatter, type LayerChange, layerNameError, LAYER_KINDS, NOTES_LAYER, splitFrontmatter,
} from '../shared/layers'
import { splitSections } from '../shared/document'
import { extractHeadings, extractSectionMarkers, sectionMarkerLine } from '../shared/text'
import { normalizeView, parseViews, type SavedView, VIEWS_FILE, writeViews } from '../shared/views'
import { type BackupStore, documentNoteOf, readTextDocument, writeTextDocument } from './fileService'
import { convertLegacyFolder, isLegacyFolder, readFolderDocument } from './legacyFolder'
import { encodeText } from './textFile'

// Layer files (PLAN.md §3c, docs/FORMAT.md): a document folder holds a main file
// named after it, whose body is the text, and one file per other layer, with
// sections as headings in each. The editor sees one working text (layerFiles.ts);
// saving splits it back and writes only the files whose content changed.

/** Where a converted document keeps its earlier files, inside its folder, so the conversion can be undone. */
export const CONVERTED_DIR = path.join('.verdandi', 'converted')
/** Where a document converted from one file keeps the original. */
export const ORIGINAL_DIR = path.join('.verdandi', 'original')

const exists = (target: string) => stat(target).then(() => true, () => false)
const NEW_FORMAT: TextFormat = { encoding: 'utf-8', eol: '\n', mixedEol: false }

// ---------------------------------------------------------------------------
// Reading

interface LayerFile {
  layer: LayerDeclaration
  file: string
  /** null when the file does not exist. */
  document: TextDocument | null
  yaml: string | null
  body: string
}

export interface LoadedDocument {
  folder: string
  /** The main file's name without `.md`, which default layer file names start with. */
  base: string
  main: TextDocument
  parsed: MainFile
  layerFiles: LayerFile[]
  assembled: Assembled
  /** Stands in for an mtime: changes whenever any of the document's files does. */
  token: number
  size: number
  modifiedMs: number
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

/** A file in `folder` by name, matched without regard to case as Obsidian does; the name as given when there is none. */
async function fileIn(folder: string, name: string, listing?: readonly string[]): Promise<string> {
  const names = listing ?? (await readdir(folder))
  return path.join(folder, names.find((candidate) => candidate.toLowerCase() === name.toLowerCase()) ?? name)
}

export async function loadDocument(folder: string): Promise<LoadedDocument> {
  const mainFile = await documentNoteOf(folder)
  if (!mainFile) throw new Error(`${path.basename(folder)} is not a document folder.`)
  const main = await readTextDocument(mainFile)
  const parsed = parseMainFile(main.text)
  const base = path.basename(mainFile).replace(/\.md$/i, '')
  const listing = await readdir(folder)
  // Layer files in the folder that the main file doesn't declare are layers too.
  parsed.layers = [...parsed.layers, ...discoverLayers(base, listing, parsed.layers)]
  const layerFiles: LayerFile[] = []
  for (const layer of parsed.layers) {
    const file = await fileIn(folder, layerFileName(base, layer), listing)
    const document = file.toLowerCase() === mainFile.toLowerCase() ? null : await readTextDocument(file).catch(() => null)
    const { yaml, body } = document ? splitFrontmatter(document.text) : { yaml: null, body: '' }
    layerFiles.push({ layer, file, document, yaml, body })
  }
  const assembled = assembleWorkingText(parsed, new Map(layerFiles.map((entry) => [entry.layer.name, entry.document ? entry.body : null])))
  const stamps = await Promise.all([mainFile, ...layerFiles.filter((entry) => entry.document).map((entry) => entry.file)].map(async (file) => {
    const info = await stat(file).catch(() => null)
    return { file, mtime: info?.mtimeMs ?? 0, size: info?.size ?? 0 }
  }))
  return {
    folder, base, main, parsed, layerFiles, assembled,
    token: tokenOf(stamps.map((stamp) => `${path.basename(stamp.file)}:${stamp.mtime}`)),
    size: stamps.reduce((sum, stamp) => sum + stamp.size, 0),
    modifiedMs: Math.max(...stamps.map((stamp) => stamp.mtime)),
  }
}

function toTextDocument(loaded: LoadedDocument, converted?: string): TextDocument {
  const { assembled } = loaded
  return {
    path: loaded.folder,
    text: assembled.text,
    format: loaded.main.format,
    mtimeMs: loaded.token,
    size: loaded.size,
    folder: true,
    layers: loaded.parsed.layers.map(({ name, kind, label }) => ({ name, kind, anchored: false, ...(label ? { label } : {}) })),
    modifiedMs: loaded.modifiedMs,
    fields: Object.fromEntries(assembled.sections.map((section) => [section.id, section.fields])),
    strays: assembled.strays.map(({ layer, name }) => ({ layer, name })),
    orphanFields: assembled.orphanFields,
    ...(converted ? { converted } : {}),
  }
}

/**
 * A document folder as one text, for the editor. A folder in the earlier format
 * (§3b) is converted first when `convert` is set (opening it in the editor), and
 * `converted` in the result then says so; otherwise it is read as it is.
 */
export async function readLayerDocument(folder: string, convert = false): Promise<TextDocument> {
  if (await isLegacyFolder(folder)) {
    if (!convert) return readFolderDocument(folder)
    if (await convertOnce(folder)) return toTextDocument(await loadDocument(folder), CONVERTED_DIR)
  }
  return toTextDocument(await loadDocument(folder))
}

/** Conversions under way, by folder: reads that arrive meanwhile wait for the one conversion. */
const converting = new Map<string, Promise<boolean>>()

/** Converts a folder in the earlier format, once however many reads ask at the same time. True for the read that converted it. */
async function convertOnce(folder: string): Promise<boolean> {
  const key = path.resolve(folder).toLowerCase()
  const running = converting.get(key)
  if (running) {
    await running.catch(() => {})
    return false
  }
  const run = (async () => {
    if (!(await isLegacyFolder(folder))) return false
    await convertLegacyFolder(folder)
    return true
  })()
  converting.set(key, run)
  try {
    return await run
  } finally {
    converting.delete(key)
  }
}

/**
 * Reads a document: a text file, or a document folder as one text. Only the
 * editor's own read (`convert`) converts a folder in the earlier format.
 */
export async function readDocument(target: string, allowMissing = false, convert = false): Promise<TextDocument> {
  const info = await stat(target).catch(() => null)
  if (info?.isDirectory() && (await documentNoteOf(target))) return readLayerDocument(target, convert)
  return readTextDocument(target, allowMissing)
}

/** Whether `target` is a document folder. */
export async function isFolderDocument(target: string): Promise<boolean> {
  const info = await stat(target).catch(() => null)
  return Boolean(info?.isDirectory() && (await documentNoteOf(target)))
}

// ---------------------------------------------------------------------------
// Working text to files

export interface FilePlan {
  /** The main file's new content, or null when it stays as it is. */
  main: string | null
  /** Each layer file's new content, by layer; null when it stays as it is (or has nothing and no file). */
  layers: Map<string, string | null>
  /** The sections' names as written: a repeated new name gets a suffix. */
  names: string[]
}

export interface PlanContext {
  level: number
  layers: readonly LayerDeclaration[]
  /** The main file as it is: its frontmatter and body; a null body when it is new. */
  mainYaml: string | null
  mainBody: string | null
  /** Each layer file's frontmatter and body as they are, or null when it has no file. */
  layerFiles: ReadonlyMap<string, { yaml: string | null; body: string } | null>
  /** The sections as read: id, name and fields (without `heading`). */
  known: readonly { id: string; name: string; fields: Record<string, unknown> }[]
  strays: readonly StraySection[]
  /** `sections` entries for names that have no heading, kept as they are. */
  orphans: Record<string, Record<string, unknown>>
}

/** What saving `text` writes: each file whose content changes, and only those. */
export function planFiles(text: string, context: PlanContext): FilePlan {
  const layerNames = context.layers.map((layer) => layer.name)
  const working = splitWorkingText(text, layerNames)
  const byId = new Map(context.known.map((section) => [section.id, section]))
  const names = uniqueSectionNames(working.sections, new Map(context.known.map((section) => [section.id, section.name])))

  // Fields follow a section by its id, through a rename; an id the editor no longer has falls back to the name.
  const used = new Set<string>()
  const fields: Record<string, Record<string, unknown>> = { ...context.orphans }
  working.sections.forEach((section, index) => {
    let source = section.id ? byId.get(section.id) : undefined
    if (!source || used.has(source.id)) source = context.known.find((candidate) => candidate.name === section.name && !used.has(candidate.id))
    if (source) used.add(source.id)
    const own: Record<string, unknown> = { ...(fields[names[index]] ?? {}), ...(source?.fields ?? {}) }
    if (!section.heading) own.heading = false
    else delete own.heading
    fields[names[index]] = own
  })

  const yaml = writeMainYaml(context.mainYaml, { fields, layers: context.layers.filter((layer) => !layer.discovered), level: context.level })
  const sections = working.sections.map((section, index) => ({ name: names[index], lines: section.text }))
  let body = writeBody(context.level, working.preamble.text, sections)
  if (context.mainBody !== null && bodyKey(context.mainBody, context.level, true) === bodyKey(body, context.level, true)) body = context.mainBody
  const main = context.mainBody !== null && yaml === context.mainYaml && body === context.mainBody ? null : joinFrontmatter(yaml, body)

  const layers = new Map<string, string | null>()
  for (const layer of context.layers) {
    const current = context.layerFiles.get(layer.name) ?? null
    const own = working.sections
      .map((section, index) => ({ name: names[index], lines: section.layers[layer.name] ?? [] }))
      .filter((section) => section.lines.length > 0)
    const strays = context.strays.filter((stray) => stray.layer === layer.name)
    const next = writeBody(context.level, working.preamble.layers[layer.name] ?? [], [...own, ...strays])
    if (current ? bodyKey(current.body, context.level, false) === bodyKey(next, context.level, false) : next === '') layers.set(layer.name, null)
    else layers.set(layer.name, joinFrontmatter(current?.yaml ?? null, next))
  }
  return { main, layers, names }
}

/** The context for planning a save of a loaded document. */
function contextOf(loaded: LoadedDocument): PlanContext {
  const orphans = Object.fromEntries(loaded.assembled.orphanFields.map((name) => [name, loaded.parsed.fields[name]]))
  return {
    level: loaded.parsed.level,
    layers: loaded.parsed.layers,
    mainYaml: splitFrontmatter(loaded.main.text).yaml,
    mainBody: splitFrontmatter(loaded.main.text).body,
    layerFiles: new Map(loaded.layerFiles.map((entry) => [entry.layer.name, entry.document ? { yaml: entry.yaml, body: entry.body } : null])),
    known: loaded.assembled.sections,
    strays: loaded.assembled.strays,
    orphans,
  }
}

/** The editor's text with each section's marker giving the name and id it now has, or null when none changed. */
function withMarkers(text: string, layers: readonly string[], names: readonly string[]): string | null {
  const markers = extractSectionMarkers(text, layers)
  const lines = text.split('\n')
  const seen = new Map<string, number>()
  let changed = false
  markers.forEach((marker, index) => {
    const name = names[index]
    const count = (seen.get(name.toLowerCase()) ?? 0) + 1
    seen.set(name.toLowerCase(), count)
    const line = sectionMarkerLine(name, { id: sectionId(name, count), heading: marker.heading })
    if (lines[marker.line - 1] !== line) {
      lines[marker.line - 1] = line
      changed = true
    }
  })
  return changed ? lines.join('\n') : null
}

/**
 * Saves the editor's text of a document folder: the main file and each layer
 * file are written only when what they hold changed. `text` in the result is the
 * editor's text with its markers giving each section's new id (made from its
 * name), when any changed.
 */
export async function writeLayerDocument(folder: string, request: WriteRequest, backups: BackupStore): Promise<WriteResult & { text?: string }> {
  const current = await loadDocument(folder)
  if (!request.force && request.expectedMtimeMs !== current.token) {
    return { ok: false, reason: 'conflict', diskMtimeMs: current.token }
  }
  const plan = planFiles(request.text, contextOf(current))
  const write = async (file: string, text: string, format: TextFormat) => {
    const result = await writeTextDocument(file, { path: file, text, format, expectedMtimeMs: null, force: true }, backups)
    if (!result.ok) throw new Error(`Couldn’t write ${path.basename(file)}.`)
  }
  // Layer files first and the main file last, so an interrupted save never leaves the text ahead of its layers.
  for (const entry of current.layerFiles) {
    const next = plan.layers.get(entry.layer.name)
    if (next != null) await write(entry.file, next, entry.document?.format ?? current.main.format)
  }
  if (plan.main !== null) await write(current.main.path, plan.main, current.main.format)
  const saved = await loadDocument(folder)
  const result: WriteResult & { text?: string } = {
    ok: true, mtimeMs: saved.token, size: saved.size, format: saved.main.format, notice: null,
    fields: Object.fromEntries(saved.assembled.sections.map((section) => [section.id, section.fields])),
  }
  const text = withMarkers(request.text, current.parsed.layers.map((layer) => layer.name), plan.names)
  if (text !== null) result.text = text
  return result
}

async function writeMain(loaded: LoadedDocument, yaml: string, backups: BackupStore): Promise<void> {
  const text = joinFrontmatter(yaml, splitFrontmatter(loaded.main.text).body)
  if (text === loaded.main.text) return
  const result = await writeTextDocument(loaded.main.path, { path: loaded.main.path, text, format: loaded.main.format, expectedMtimeMs: null, force: true }, backups)
  if (!result.ok) throw new Error(`Couldn’t write ${path.basename(loaded.main.path)}.`)
}

// ---------------------------------------------------------------------------
// Layers, fields and views

/**
 * Changes the document's layers. Adding one only declares it (its file is made
 * when it first has content); renaming renames its file too when the file has the
 * default name; deleting moves its file to the trash (backed up first).
 */
export async function changeLayers(folder: string, change: LayerChange, backups: BackupStore, trash: (target: string) => Promise<void>): Promise<void> {
  const current = await loadDocument(folder)
  let next: LayerDeclaration[] = current.parsed.layers
  const find = (name: unknown) => {
    const layer = typeof name === 'string' ? next.find((candidate) => candidate.name === name) : undefined
    if (!layer) throw new Error(`The document has no layer called “${String(name)}”.`)
    return layer
  }
  const fileOf = (layer: LayerDeclaration) => current.layerFiles.find((entry) => entry.layer.name === layer.name)
  if ('add' in change) {
    const name = String(change.add?.name ?? '').trim().toLowerCase()
    const error = layerNameError(name, next)
    if (error) throw new Error(error)
    const kind = LAYER_KINDS.includes(change.add.kind) ? change.add.kind : 'prose'
    next = [...next, { name, kind, anchored: false }]
  } else if ('rename' in change) {
    const layer = find(change.rename)
    const to = String(change.to ?? '').trim().toLowerCase()
    if (to === layer.name) return
    const error = layerNameError(to, next, layer.name)
    if (error) throw new Error(error)
    const renamed = { ...layer, name: to }
    next = next.map((candidate) => (candidate === layer ? renamed : candidate))
    const entry = fileOf(layer)
    if (entry?.document && hasDefaultFile(layer)) {
      const target = path.join(folder, layerFileName(current.base, renamed))
      if (target.toLowerCase() !== entry.file.toLowerCase() && (await exists(target))) throw new Error(`The folder already has a file called “${path.basename(target)}”.`)
      await rename(entry.file, target)
    }
  } else if ('remove' in change) {
    const layer = find(change.remove)
    next = next.filter((candidate) => candidate !== layer)
    const entry = fileOf(layer)
    if (entry?.document) {
      await backups.ensureBackup(entry.file)
      await trash(entry.file)
    }
  } else if ('change' in change) {
    const layer = find(change.change)
    const kind = change.kind && LAYER_KINDS.includes(change.kind) ? change.kind : layer.kind
    next = next.map((candidate) => (candidate === layer ? { ...candidate, kind } : candidate))
  } else {
    throw new TypeError('Unknown layer change.')
  }
  await writeMain(current, writeMainYaml(splitFrontmatter(current.main.text).yaml, { layers: next }), backups)
}

/**
 * Changes one section's fields, under `sections` in the main file's frontmatter.
 * `expectedMtimeMs` is the document's token as the editor last saved it, so a
 * change made outside meanwhile is not written over. Returns the document's new
 * token and the section's fields.
 */
export async function setSectionFields(
  folder: string, id: string, change: FieldChange, expectedMtimeMs: number | null, backups: BackupStore,
): Promise<{ mtimeMs: number; fields: Record<string, unknown> }> {
  const current = await loadDocument(folder)
  if (expectedMtimeMs !== null && expectedMtimeMs !== current.token) {
    throw new Error('The document changed on disk. Reload it, then try again.')
  }
  const section = current.assembled.sections.find((candidate) => candidate.id === id)
  if (!section) throw new Error('That section isn’t in the files yet. Try again once it has saved.')
  const own = { ...(current.parsed.fields[section.name] ?? {}) }
  for (const key of [...change.remove, ...Object.keys(change.set)]) {
    if (!key.trim()) throw new FrontmatterError('A field needs a name.')
    if (isOwnField(key)) throw new FrontmatterError(`“${key}” is kept by Verdandi and can’t be changed here.`)
  }
  for (const key of change.remove) delete own[key]
  Object.assign(own, change.set)
  for (const [key, value] of Object.entries(own)) if (value === undefined) delete own[key]
  const fields = { ...current.parsed.fields, [section.name]: own }
  await writeMain(current, writeMainYaml(splitFrontmatter(current.main.text).yaml, { fields }), backups)
  const saved = await loadDocument(folder)
  return { mtimeMs: saved.token, fields: saved.assembled.sections.find((candidate) => candidate.id === id)?.fields ?? {} }
}

const viewsFile = (folder: string) => path.join(folder, '.verdandi', VIEWS_FILE)

/** A document folder's saved views; none when it has no `views.yaml`. */
export async function readViews(folder: string): Promise<SavedView[]> {
  const { parsed } = await loadDocument(folder)
  const text = await readFile(viewsFile(folder), 'utf8').catch(() => null)
  return text === null ? [] : parseViews(text, parsed.layers.map((layer) => layer.name))
}

/** Writes a document folder's saved views; with none left, the file goes. */
export async function saveViews(folder: string, views: unknown): Promise<void> {
  if (!Array.isArray(views)) throw new TypeError('views must be a list')
  const layers = (await loadDocument(folder)).parsed.layers.map((layer) => layer.name)
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

/** A new document's main file: the notes layer, and one section whose heading exports leave out. */
export function newMainFile(layers: readonly LayerDeclaration[] = [NOTES_LAYER], section = INTRODUCTION): string {
  const yaml = writeMainYaml(null, { layers, fields: { [section]: { heading: false } } })
  return joinFrontmatter(yaml, writeBody(DEFAULT_SECTION_LEVEL, [], [{ name: section, lines: [] }]))
}

/** Makes a new document folder with its main file and returns the folder's path. */
export async function createLayerDocument(parent: string, name: string): Promise<string> {
  const folder = path.join(parent, name)
  if (await exists(folder)) throw new Error(`“${name}” already exists here.`)
  if (await exists(`${folder}.md`)) throw new Error(`“${name}.md” already exists here.`)
  const section = name.toLowerCase() === INTRODUCTION.toLowerCase() ? `${INTRODUCTION} 2` : INTRODUCTION
  await mkdir(folder)
  try {
    await writeFile(path.join(folder, `${name}.md`), encodeText(newMainFile([NOTES_LAYER], section), NEW_FORMAT).bytes, { flag: 'wx' })
  } catch (error) {
    await rm(folder, { recursive: true, force: true })
    throw error
  }
  return folder
}

/**
 * Renames a document folder with its main file and the layer files that have
 * default names (`<Document> - <Layer>.md`), and returns the new path.
 */
export async function renameLayerDocument(folder: string, name: string): Promise<string> {
  const target = path.join(path.dirname(folder), name)
  if (path.basename(folder) === name) return folder
  if (target.toLowerCase() !== folder.toLowerCase() && (await exists(target))) throw new Error(`“${name}” already exists here.`)
  const loaded = await loadDocument(folder)
  const moves: { from: string; to: string }[] = [{ from: loaded.main.path, to: path.join(folder, `${name}.md`) }]
  for (const entry of loaded.layerFiles) {
    if (entry.document && hasDefaultFile(entry.layer)) moves.push({ from: entry.file, to: path.join(folder, layerFileName(name, entry.layer)) })
  }
  for (const move of moves) {
    if (move.to.toLowerCase() !== move.from.toLowerCase() && (await exists(move.to))) throw new Error(`The folder already has a file called “${path.basename(move.to)}”.`)
  }
  const done: typeof moves = []
  try {
    for (const move of moves) {
      await rename(move.from, move.to)
      done.push(move)
    }
    await rename(folder, target)
  } catch (error) {
    for (const move of done.reverse()) await rename(move.to, move.from).catch(() => {})
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
  folder: string
  /** The main file inside it, named after the folder. */
  main: string
  /** Where the original file now is. */
  original: string
}

/**
 * The working text of a one-file document, as layer files would give it: its
 * sections start at its section markers, or else at its headings of the shallowest
 * level used (the next level down when that level has only a title above the
 * rest). Its `::: notes` blocks stay as they are. Returns the text and the level.
 */
export function workingTextOf(text: string): { text: string; level: number } {
  const lines = text.split('\n')
  const markers = extractSectionMarkers(text)
  if (markers.length > 0) {
    // Markers name sections; headings at the level they would split at become markers too.
    const parts: string[] = []
    for (const section of splitSections(text)) {
      const body = lines.slice(section.title === null ? 0 : section.line, section.endLine)
      parts.push(section.title === null ? body.join('\n') : [sectionMarkerLine(section.title, { id: 'new', heading: !section.named }), ...body].join('\n'))
    }
    return { text: parts.join('\n'), level: DEFAULT_SECTION_LEVEL }
  }
  const headings = extractHeadings(text)
  if (headings.length === 0) return { text, level: DEFAULT_SECTION_LEVEL }
  let level = Math.min(...headings.map((heading) => heading.level))
  const top = headings.filter((heading) => heading.level === level)
  if (top.length === 1 && top[0] === headings[0] && headings.some((heading) => heading.level > level)) {
    level = Math.min(...headings.filter((heading) => heading.level > level).map((heading) => heading.level))
  }
  const starts = new Map(headings.filter((heading) => heading.level === level).map((heading) => [heading.line, heading.text]))
  return { text: lines.map((line, index) => (starts.has(index + 1) ? sectionMarkerLine(starts.get(index + 1)!, { id: 'new', heading: true }) : line)).join('\n'), level }
}

/** The files for a one-file document: its main file, and a notes file when it has notes. */
export function convertText(text: string, name: string): { main: string; layers: Map<string, string> } {
  const working = workingTextOf(text)
  const plan = planFiles(working.text, {
    level: working.level, layers: [NOTES_LAYER], mainYaml: null, mainBody: null, layerFiles: new Map(), known: [], strays: [], orphans: {},
  })
  const layers = new Map<string, string>()
  const notes = plan.layers.get(NOTES_LAYER.name)
  if (notes) layers.set(layerFileName(name, NOTES_LAYER), notes)
  return { main: plan.main ?? '', layers }
}

/**
 * Turns a one-file document into a document folder next to it: a main file with
 * its text, a notes file when it has notes, and the original kept in
 * `.verdandi/original/` so the conversion can be undone. Everything is written to
 * a hidden folder first and renamed into place last, so a failure leaves the
 * original where it was.
 */
export async function convertFileToFolder(file: string): Promise<ConvertedFolder> {
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
  const converted = convertText(source.text, name)
  const format = { encoding: 'utf-8', eol: source.format.eol, mixedEol: false } as const
  const write = (target: string, text: string) => writeFile(target, encodeText(text, format).bytes, { flag: 'wx' })

  const staging = path.join(parent, `.${name}.verdandi-${randomBytes(4).toString('hex')}`)
  await mkdir(path.join(staging, ORIGINAL_DIR), { recursive: true })
  try {
    await write(path.join(staging, `${name}.md`), converted.main)
    for (const [layerFile, text] of converted.layers) await write(path.join(staging, layerFile), text)
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
  return { folder, main: path.join(folder, `${name}.md`), original: path.join(folder, ORIGINAL_DIR, fileName) }
}

/**
 * Undoes converting one file: puts the original back next to the folder and moves
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
