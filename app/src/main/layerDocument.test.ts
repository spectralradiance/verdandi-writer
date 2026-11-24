import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { splitSections } from '../shared/document'
import { sectionId } from '../shared/layerFiles'
import { sectionMarkerLine } from '../shared/text'
import { BackupStore, PathGuard } from './fileService'
import {
  changeLayers, convertFileToFolder, createLayerDocument, isFolderDocument, ORIGINAL_DIR, readLayerDocument, readViews, renameLayerDocument, saveViews,
  undoConversion, writeLayerDocument,
} from './layerDocument'

const trash = (target: string) => rm(target, { recursive: true, force: true })
const backups = async () => new BackupStore(await mkdtemp(path.join(tmpdir(), 'verdandi-backups-')), new PathGuard(() => [tmpdir()]))

const MAIN = `---
verdandi: document
layers:
  - {name: notes, kind: prose}
  - {name: outline, kind: list}
sections:
  One: {status: draft}
---
# Eras

## One

First.

## Two

Second.
`

/** A document folder written by hand, as docs/FORMAT.md describes. */
async function document(files: Record<string, string> = {}) {
  const parent = await mkdtemp(path.join(tmpdir(), 'verdandi-layers-'))
  const folder = path.join(parent, 'Eras')
  await mkdir(folder)
  const all = { 'Eras.md': MAIN, 'Eras - Notes.md': 'About the book.\n\n## Two\n\nA note on two.\n', ...files }
  for (const [name, text] of Object.entries(all)) await writeFile(path.join(folder, name), text)
  return folder
}

const read = (folder: string, name: string) => readFile(path.join(folder, name), 'utf8')
const mtime = async (folder: string, name: string) => (await stat(path.join(folder, name))).mtimeMs

async function save(folder: string, edit: (text: string) => string) {
  const before = await readLayerDocument(folder)
  const result = await writeLayerDocument(folder, { path: folder, text: edit(before.text), format: before.format, expectedMtimeMs: before.mtimeMs }, await backups())
  if (!result.ok) throw new Error('conflict')
  return result
}

describe('reading a document folder', () => {
  it('shows the main file and its layer files as one text', async () => {
    const folder = await document()
    expect(await isFolderDocument(folder)).toBe(true)
    const doc = await readLayerDocument(folder)
    expect(doc.folder).toBe(true)
    expect(doc.layers?.map((layer) => layer.name)).toEqual(['notes', 'outline'])
    const sections = splitSections(doc.text, ['notes', 'outline'])
    expect(sections.map((section) => section.title)).toEqual([null, 'One', 'Two'])
    expect(sections[0].output).toBe('# Eras')
    expect(sections[0].notes).toBe('About the book.')
    expect(sections[2].layers.notes).toBe('A note on two.')
    expect(doc.fields?.[sectionId('One', 1)]).toEqual({ status: 'draft' })
    expect(doc.strays).toEqual([])
  })

  it('reads layers named with spaces, and layer files the main file does not declare', async () => {
    const main = MAIN.replace('  - {name: outline, kind: list}\n', '  - {name: outline, kind: list}\n  - {name: draft 11-21, kind: prose, file: Eras - Draft 11-21.md}\n')
    const folder = await document({ 'Eras.md': main, 'Eras - Draft 11-21.md': '## One\n\nAn old one.\n', 'Eras - Draft 10-18.md': '## Two\n\nOlder two.\n', 'Elsewhere.md': 'Not a layer.\n' })
    const doc = await readLayerDocument(folder)
    expect(doc.layers?.map((layer) => [layer.name, layer.label])).toEqual([
      ['notes', undefined], ['outline', undefined], ['draft-11-21', 'draft 11-21'], ['draft-10-18', 'Draft 10-18'],
    ])
    const names = doc.layers!.map((layer) => layer.name)
    const sections = splitSections(doc.text, names)
    expect(sections[1].layers['draft-11-21']).toBe('An old one.')
    expect(sections[2].layers['draft-10-18']).toBe('Older two.')
    // Saving the text leaves the main file's layers as written.
    await save(folder, (text) => text.replace('First.', 'First, edited.'))
    expect(await read(folder, 'Eras.md')).toContain('{name: draft 11-21, kind: prose, file: Eras - Draft 11-21.md}')
    expect(await read(folder, 'Eras.md')).not.toContain('10-18')
    expect(await read(folder, 'Eras - Draft 10-18.md')).toBe('## Two\n\nOlder two.\n')
  })

  it('reads a document whose layer files are missing', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'verdandi-layers-'))
    const folder = path.join(parent, 'Eras')
    await mkdir(folder)
    await writeFile(path.join(folder, 'Eras.md'), MAIN)
    const doc = await readLayerDocument(folder)
    expect(splitSections(doc.text, ['notes', 'outline']).map((section) => section.title)).toEqual([null, 'One', 'Two'])
  })
})

describe('saving a document folder', () => {
  it('writes only the files whose content changed', async () => {
    const folder = await document({ 'Eras - Notes.md': 'About the book.\n\n\n## Two\nA note on two.\n' })
    const notes = await mtime(folder, 'Eras - Notes.md')
    await save(folder, (text) => text.replace('First.', 'First, and more.'))
    expect(await read(folder, 'Eras.md')).toBe(MAIN.replace('First.', 'First, and more.'))
    // Spaced differently, but with the same content: left alone.
    expect(await mtime(folder, 'Eras - Notes.md')).toBe(notes)
    expect(await readdir(folder)).not.toContain('Eras - Outline.md')
  })

  it('writes a layer file when a layer first has content, in the main file’s order', async () => {
    const folder = await document()
    await save(folder, (text) => text.replace('Second.', 'Second.\n\n::: outline\n- the second\n:::').replace('First.', 'First.\n\n::: notes\nA note on one.\n:::'))
    expect(await read(folder, 'Eras - Outline.md')).toBe('## Two\n\n- the second\n')
    expect(await read(folder, 'Eras - Notes.md')).toBe('About the book.\n\n## One\n\nA note on one.\n\n## Two\n\nA note on two.\n')
    expect(await read(folder, 'Eras.md')).toBe(MAIN)
  })

  it('refuses to save over changes made on disk', async () => {
    const folder = await document()
    const doc = await readLayerDocument(folder)
    await writeFile(path.join(folder, 'Eras - Notes.md'), 'Changed in Obsidian.\n')
    const result = await writeLayerDocument(folder, { path: folder, text: doc.text, format: doc.format, expectedMtimeMs: doc.mtimeMs }, await backups())
    expect(result.ok).toBe(false)
  })

  it('renames a section in every file, its fields following it, and gives the editor its new id', async () => {
    const folder = await document({ 'Eras - Notes.md': '## One\n\nOn one.\n\n## Two\n\nOn two.\n' })
    const result = await save(folder, (text) => text.replace(/<!-- section: One \{[^}]*\} -->/, sectionMarkerLine('Uno', { id: sectionId('One', 1), heading: true })))
    expect(await read(folder, 'Eras.md')).toContain('sections:\n  Uno: {status: draft}\n---\n# Eras\n\n## Uno\n\nFirst.')
    expect(await read(folder, 'Eras - Notes.md')).toBe('## Uno\n\nOn one.\n\n## Two\n\nOn two.\n')
    expect(result.text).toContain(sectionMarkerLine('Uno', { id: sectionId('Uno', 1), heading: true }))
  })

  it('moves, deletes and adds sections, a repeated new name getting a suffix', async () => {
    const folder = await document()
    const result = await save(folder, (text) => {
      const [lead, one, two] = text.split(/\n(?=<!-- section)/)
      return [lead, two, '<!-- section: Two {.heading} -->\nAnother two.', '<!-- section: Three -->\nThird.'].join('\n').replace(one, '')
    })
    const main = await read(folder, 'Eras.md')
    expect(main).not.toContain('One')
    expect(main).toContain('## Two\n\nSecond.\n\n## Two (2)\n\nAnother two.\n\n## Three\n\nThird.\n')
    expect(main).toContain('sections:\n  Three: {heading: false}\n')
    expect(result.text).toContain('<!-- section: Two (2) {')
  })

  it('keeps headings that match no section, and pairs a heading renamed in one file only', async () => {
    const folder = await document({ 'Eras - Notes.md': '## One\n\nOn one.\n\n## Deux\n\nOn two.\n\n## Elsewhere\n\nKept.\n' })
    let doc = await readLayerDocument(folder)
    // Two strays: neither is paired.
    expect(doc.strays).toEqual([{ layer: 'notes', name: 'Deux' }, { layer: 'notes', name: 'Elsewhere' }])
    await save(folder, (text) => text.replace('First.', 'First!'))
    expect(await read(folder, 'Eras - Notes.md')).toBe('## One\n\nOn one.\n\n## Deux\n\nOn two.\n\n## Elsewhere\n\nKept.\n')

    await writeFile(path.join(folder, 'Eras - Notes.md'), '## One\n\nOn one.\n\n## Deux\n\nOn two.\n')
    doc = await readLayerDocument(folder)
    expect(doc.strays).toEqual([])
    expect(splitSections(doc.text, ['notes'])[2].notes).toBe('On two.')
    await save(folder, (text) => text.replace('First!', 'First.'))
    expect(await read(folder, 'Eras - Notes.md')).toBe('## One\n\nOn one.\n\n## Two\n\nOn two.\n')
  })
})

describe('layers, views and names', () => {
  it('adds, renames and deletes layers with their files', async () => {
    const folder = await document()
    const store = await backups()
    await changeLayers(folder, { add: { name: 'research', kind: 'prose', anchored: true } }, store, trash)
    expect(await read(folder, 'Eras.md')).toContain('  - {name: research, kind: prose}\n')
    await changeLayers(folder, { rename: 'notes', to: 'asides' }, store, trash)
    expect(await readdir(folder)).toContain('Eras - Asides.md')
    expect(await read(folder, 'Eras.md')).toContain('  - {name: asides, kind: prose}\n')
    const doc = await readLayerDocument(folder)
    expect(splitSections(doc.text, ['asides'])[0].layers.asides).toBe('About the book.')
    await changeLayers(folder, { remove: 'asides' }, store, trash)
    expect(await readdir(folder)).not.toContain('Eras - Asides.md')
    expect(await read(folder, 'Eras.md')).not.toContain('asides')
  })

  it('keeps saved views in .verdandi', async () => {
    const folder = await document()
    expect(await readViews(folder)).toEqual([])
    await saveViews(folder, [{ name: 'Notes', primary: 'notes' }])
    expect((await readViews(folder)).map((view) => [view.name, view.primary])).toEqual([['Notes', 'notes']])
  })

  it('renames the folder, its main file and its layer files together', async () => {
    const folder = await document({ 'Plan.md': '## One\n\n- a\n' })
    await writeFile(path.join(folder, 'Eras.md'), MAIN.replace('kind: list}', 'kind: list, file: Plan.md}'))
    const renamed = await renameLayerDocument(folder, 'Ages')
    expect((await readdir(renamed)).sort()).toEqual(['Ages - Notes.md', 'Ages.md', 'Plan.md'])
  })

  it('creates a document with one section', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'verdandi-new-'))
    const folder = await createLayerDocument(parent, 'Book')
    expect(await read(folder, 'Book.md')).toBe('---\nverdandi: document\nlayers:\n  - {name: notes, kind: prose}\nsections:\n  Introduction: {heading: false}\n---\n## Introduction\n')
    const doc = await readLayerDocument(folder)
    expect(doc.text).toBe(sectionMarkerLine('Introduction', { id: sectionId('Introduction', 1), heading: false }))
  })
})

describe('converting a one-file document', () => {
  const SOURCE = '# One\r\nFirst.\r\n\r\n::: notes\r\nA note.\r\n:::\r\n\r\n# Two\r\nSecond.\r\n'

  async function file(name: string, text: string) {
    const parent = await mkdtemp(path.join(tmpdir(), 'verdandi-convert-'))
    const target = path.join(parent, name)
    await writeFile(target, text)
    return { parent, target }
  }

  it('writes the main file and a notes file, keeping the original and its line endings', async () => {
    const { parent, target } = await file('Eras.md', SOURCE)
    const converted = await convertFileToFolder(target)
    expect(converted.folder).toBe(path.join(parent, 'Eras'))
    expect(await readdir(parent)).toEqual(['Eras'])
    expect((await readdir(converted.folder)).sort()).toEqual(['.verdandi', 'Eras - Notes.md', 'Eras.md'])
    expect(await read(converted.folder, 'Eras.md')).toBe('---\r\nverdandi: document\r\nsection-level: 1\r\nlayers:\r\n  - {name: notes, kind: prose}\r\n---\r\n# One\r\n\r\nFirst.\r\n\r\n# Two\r\n\r\nSecond.\r\n')
    expect(await read(converted.folder, 'Eras - Notes.md')).toBe('# One\r\n\r\nA note.\r\n')
    expect(await readFile(converted.original, 'utf8')).toBe(SOURCE)
    expect(splitSections((await readLayerDocument(converted.folder)).text, ['notes'])[0].notes).toBe('A note.')
  })

  it('reads a single title above the chapters as the title', async () => {
    const { target } = await file('Book.md', '# Book\n\nFor M.\n\n## A\ntext\n### Deep\n## B\nmore\n')
    const converted = await convertFileToFolder(target)
    expect(await read(converted.folder, 'Book.md')).toBe('---\nverdandi: document\nlayers:\n  - {name: notes, kind: prose}\n---\n# Book\n\nFor M.\n\n## A\n\ntext\n### Deep\n\n## B\n\nmore\n')
  })

  it('keeps sections named by markers, their headings left out of exports', async () => {
    const { target } = await file('Book.md', '# A\ntext\n\n<!-- section: Scene -->\nmore\n')
    const converted = await convertFileToFolder(target)
    expect(await read(converted.folder, 'Book.md')).toContain('sections:\n  Scene: {heading: false}\n---\n## A\n\ntext\n\n## Scene\n\nmore\n')
  })

  it('picks a free folder name, and undoes the conversion', async () => {
    const { parent, target } = await file('outline', '# A\ntext\n')
    await writeFile(path.join(parent, 'outline 2'), 'taken')
    const converted = await convertFileToFolder(target)
    expect(converted.folder).toBe(path.join(parent, 'outline'))
    expect(await readdir(path.join(converted.folder, ORIGINAL_DIR))).toEqual(['outline'])
    expect(await undoConversion(converted.folder, trash)).toBe(target)
    expect(await readFile(target, 'utf8')).toBe('# A\ntext\n')
  })
})
