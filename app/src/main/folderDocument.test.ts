import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { parseDocumentNote } from '../shared/layers'
import { BackupStore, PathGuard } from './fileService'
import {
  changeLayers, convertFileToFolder, isFolderDocument, ORIGINAL_DIR, readFolderDocument, readViews, saveViews, undoConversion, writeFolderDocument,
} from './folderDocument'

const ids = () => {
  let count = 0
  return () => `id${(count += 1)}`
}

const SOURCE = '# One\r\nFirst.\r\n\r\n::: notes\r\nA note.\r\n:::\r\n\r\n# Two\r\nSecond.\r\n'

async function folderWith(name: string, text: string) {
  const parent = await mkdtemp(path.join(tmpdir(), 'verdandi-convert-'))
  const file = path.join(parent, name)
  await writeFile(file, text)
  return { parent, file }
}

const trash = (target: string) => rm(target, { recursive: true, force: true })

describe('convertFileToFolder', () => {
  it('writes the document note and sections, keeping the original and its line endings', async () => {
    const { parent, file } = await folderWith('Eras.md', SOURCE)
    const converted = await convertFileToFolder(file, ids())
    expect(converted.folder).toBe(path.join(parent, 'Eras'))
    expect(await readdir(parent)).toEqual(['Eras'])
    expect((await readdir(converted.folder)).sort()).toEqual(['.verdandi', 'Eras.md', 'One.md', 'Two.md'])
    expect(parseDocumentNote((await readFile(converted.note, 'utf8')).replace(/\r\n/g, '\n')).sections).toEqual(['One', 'Two'])
    expect(await readFile(path.join(converted.folder, 'One.md'), 'utf8')).toBe('---\r\nid: id1\r\n---\r\nFirst.\r\n\r\n> [!notes]\r\n> A note.\r\n')
    expect(await readFile(converted.original, 'utf8')).toBe(SOURCE)
  })

  it('picks a free folder name, and handles files without an extension', async () => {
    const { parent, file } = await folderWith('outline', '# A\ntext\n')
    await writeFile(path.join(parent, 'outline 2'), 'taken')
    const converted = await convertFileToFolder(file, ids())
    expect(converted.folder).toBe(path.join(parent, 'outline'))
    expect((await readdir(converted.folder)).sort()).toEqual(['.verdandi', 'A.md', 'outline.md'])
    expect(await undoConversion(converted.folder, trash)).toBe(file)
    expect(await readFile(file, 'utf8')).toBe('# A\ntext\n')
  })

  it('numbers the folder when one of that name exists', async () => {
    const { parent, file } = await folderWith('Eras.md', SOURCE)
    await writeFile(path.join(parent, 'Eras'), 'a file in the way')
    const converted = await convertFileToFolder(file, ids())
    expect(path.basename(converted.folder)).toBe('Eras 2')
    expect(path.basename(converted.note)).toBe('Eras 2.md')
  })
})

describe('reading and saving a document folder', () => {
  const NOTE_TEXT = '# One\nFirst.\n\n::: notes\nA note.\n:::\n\n# Two\nSecond.\n\n<!-- section: Three -->\nThird.\n'

  async function opened() {
    const { parent, file } = await folderWith('Eras.md', NOTE_TEXT)
    const { folder } = await convertFileToFolder(file, ids())
    const backups = new BackupStore(path.join(parent, '.backups'), new PathGuard(() => [parent]))
    const trashed: string[] = []
    const trashFn = async (target: string) => {
      trashed.push(path.basename(target))
      await rm(target, { recursive: true, force: true })
    }
    const document = await readFolderDocument(folder)
    const save = async (text: string, expected = document.mtimeMs) => {
      const result = await writeFolderDocument(folder, { path: folder, text, format: document.format, expectedMtimeMs: expected }, backups, trashFn)
      if (!result.ok) throw new Error('conflict')
      return result
    }
    const read = (name: string) => readFile(path.join(folder, name), 'utf8')
    const names = async () => (await readdir(folder)).filter((name) => name.endsWith('.md')).sort()
    return { folder, document, save, read, names, trashed }
  }

  it('shows the sections as one text, each marker carrying its id', async () => {
    const { document } = await opened()
    expect(document.text).toBe([
      '<!-- section: One {#id1 .heading} -->',
      'First.',
      '',
      '::: notes',
      'A note.',
      ':::',
      '<!-- section: Two {#id2 .heading} -->',
      'Second.',
      '<!-- section: Three {#id3} -->',
      'Third.',
    ].join('\n'))
    expect(await isFolderDocument(path.dirname(path.join(document.path, 'x')))).toBe(true)
  })

  it('writes only the sections that changed', async () => {
    const { document, save, read, folder } = await opened()
    const before = await Promise.all(['One.md', 'Two.md', 'Three.md', 'Eras.md'].map((name) => stat(path.join(folder, name))))
    const result = await save(document.text.replace('Second.', 'Second, edited.'))
    expect(result.text).toBeUndefined()
    expect(await read('Two.md')).toBe('---\nid: id2\n---\nSecond, edited.\n')
    const after = await Promise.all(['One.md', 'Two.md', 'Three.md', 'Eras.md'].map((name) => stat(path.join(folder, name))))
    expect(after.map((info, index) => info.mtimeMs === before[index].mtimeMs)).toEqual([true, false, true, true])
    expect(result.mtimeMs).not.toBe(document.mtimeMs)
    expect((await readFolderDocument(folder)).text).toBe(document.text.replace('Second.', 'Second, edited.'))
  })

  it('refuses to save over changes made on disk', async () => {
    const { document, save, folder } = await opened()
    await writeFile(path.join(folder, 'One.md'), '---\nid: id1\n---\nChanged elsewhere.\n')
    await expect(save(document.text.replace('Third.', 'Mine.'))).rejects.toThrow('conflict')
  })

  it('renames, reorders, splits and deletes sections across files', async () => {
    const { document, save, read, names, trashed } = await opened()
    // Rename Two to "Era: Dawn", move Three above it, and split One after its note.
    const renamed = document.text
      .replace('<!-- section: Two {#id2 .heading} -->\nSecond.\n<!-- section: Three {#id3} -->\nThird.',
        '<!-- section: Three {#id3} -->\nThird.\n<!-- section: Era: Dawn {#id2 .heading} -->\nSecond.')
      .replace('A note.\n:::\n', 'A note.\n:::\n<!-- section: New section -->\nSplit off.\n')
    const result = await save(renamed)
    expect(await names()).toEqual(['Era - Dawn.md', 'Eras.md', 'New section.md', 'One.md', 'Three.md'])
    expect(await read('Era - Dawn.md')).toBe('---\nid: id2\ntitle: "Era: Dawn"\n---\nSecond.\n')
    expect(parseDocumentNote(await read('Eras.md')).sections).toEqual(['One', 'New section', 'Three', 'Era - Dawn'])
    // The new section was given an id, which the editor takes so that saving again changes nothing.
    expect(result.text).toMatch(/<!-- section: New section \{#s[0-9a-z]{7}\} -->/)
    const id = /\{#(s[0-9a-z]{7})\}/.exec(result.text!)![1]
    expect(await read('New section.md')).toBe(`---\nid: ${id}\nheading: false\n---\nSplit off.\n`)
    const again = await save(result.text!, result.mtimeMs)
    expect(again.text).toBeUndefined()
    expect(again.mtimeMs).toBe(result.mtimeMs)

    // Deleting a section moves its file to the trash.
    const without = result.text!.replace('<!-- section: Three {#id3} -->\nThird.\n', '')
    await save(without, again.mtimeMs)
    expect(trashed).toEqual(['Three.md'])
    expect(await names()).toEqual(['Era - Dawn.md', 'Eras.md', 'New section.md', 'One.md'])
  })

  it('switches between a heading and a name only in the frontmatter', async () => {
    const { document, save, read } = await opened()
    await save(document.text.replace('{#id3}', '{#id3 .heading}').replace('{#id1 .heading}', '{#id1}'))
    expect(await read('Three.md')).toBe('---\nid: id3\n---\nThird.\n')
    expect(await read('One.md')).toBe('---\nid: id1\nheading: false\n---\nFirst.\n\n> [!notes]\n> A note.\n')
  })

  it('reads a section file made in Obsidian, and gives it an id when it is saved', async () => {
    const { folder, read, save } = await opened()
    await writeFile(path.join(folder, 'Four.md'), 'Written in Obsidian.\n')
    await writeFile(path.join(folder, 'Eras.md'), `${await read('Eras.md')}![[four]]\n`)
    const document = await readFolderDocument(folder)
    const marker = /<!-- section: Four \{#(s[0-9a-z]{7}) \.heading\} -->\nWritten in Obsidian\./.exec(document.text)
    expect(marker).not.toBeNull()
    expect((await readFolderDocument(folder)).text).toBe(document.text)
    await save(document.text.replace('Written in Obsidian.', 'Edited in Verdandi.'), document.mtimeMs)
    expect(await read('Four.md')).toBe(`---\nid: ${marker![1]}\n---\nEdited in Verdandi.\n`)
  })
})

describe('undoConversion', () => {
  it('puts the original back and trashes the folder', async () => {
    const { parent, file } = await folderWith('Eras.md', SOURCE)
    const converted = await convertFileToFolder(file, ids())
    const trashed: string[] = []
    expect(await undoConversion(converted.folder, async (target) => {
      trashed.push(path.basename(target))
      await trash(target)
    })).toBe(file)
    expect(trashed).toEqual(['Eras'])
    expect(await readdir(parent)).toEqual(['Eras.md'])
    expect(await readFile(file, 'utf8')).toBe(SOURCE)
  })

  it('refuses a folder that was not converted, or whose original is in the way', async () => {
    const { parent, file } = await folderWith('Eras.md', SOURCE)
    await expect(undoConversion(parent, trash)).rejects.toThrow(/nothing to undo/)
    const converted = await convertFileToFolder(file, ids())
    await writeFile(file, 'new')
    await expect(undoConversion(converted.folder, trash)).rejects.toThrow(/already exists/)
    expect(await readdir(path.join(converted.folder, ORIGINAL_DIR))).toEqual(['Eras.md'])
  })
})

describe('layers and views of a document folder', () => {
  async function converted() {
    const { parent, file } = await folderWith('Eras.md', SOURCE.replace(/\r\n/g, '\n'))
    const { folder } = await convertFileToFolder(file, ids())
    const backups = new BackupStore(path.join(parent, '.backups'), new PathGuard(() => [parent]))
    return { folder, backups }
  }

  it('adds, renames and deletes layers across the section files', async () => {
    const { folder, backups } = await converted()
    await changeLayers(folder, { add: { name: 'Outline', kind: 'list', anchored: false } }, backups)
    let document = await readFolderDocument(folder)
    expect(document.layers?.map((layer) => [layer.name, layer.kind])).toEqual([['notes', 'prose'], ['outline', 'list']])
    await expect(changeLayers(folder, { add: { name: 'notes', kind: 'prose', anchored: false } }, backups)).rejects.toThrow(/already/)
    await expect(changeLayers(folder, { add: { name: 'text', kind: 'prose', anchored: false } }, backups)).rejects.toThrow()

    await changeLayers(folder, { rename: 'notes', to: 'remarks' }, backups)
    expect(await readFile(path.join(folder, 'One.md'), 'utf8')).toBe('---\nid: id1\n---\nFirst.\n\n> [!remarks]\n> A note.\n')
    document = await readFolderDocument(folder)
    expect(document.text).toContain('::: remarks\nA note.\n:::')

    await changeLayers(folder, { remove: 'remarks' }, backups)
    expect(await readFile(path.join(folder, 'One.md'), 'utf8')).toBe('---\nid: id1\n---\nFirst.\n')
    expect((await readFolderDocument(folder)).layers?.map((layer) => layer.name)).toEqual(['outline'])
  })

  it('gives each section its fields, and keeps saved views in .verdandi', async () => {
    const { folder } = await converted()
    await writeFile(path.join(folder, 'Two.md'), '---\nid: id2\nstatus: draft\ntags: [act-1]\n---\nSecond.\n')
    const document = await readFolderDocument(folder)
    expect(document.fields).toEqual({ id1: {}, id2: { status: 'draft', tags: ['act-1'] } })

    expect(await readViews(folder)).toEqual([])
    await saveViews(folder, [{ name: 'Drafts', primary: 'notes', shown: ['output', 'nonsense'], filter: { status: 'draft' } }])
    expect(await readFile(path.join(folder, '.verdandi', 'views.yaml'), 'utf8')).toBe(
      'views:\n  - name: Drafts\n    primary: notes\n    columns:\n      - layers:\n          - output\n    filter:\n      status: draft\n',
    )
    // A view in the shape saved before columns is written in the new one.
    expect((await readViews(folder))[0]).toMatchObject({ name: 'Drafts', primary: 'notes', columns: [{ layers: ['output'], mode: 'tabs' }], filter: { status: 'draft' } })
    await saveViews(folder, [])
    expect(await readdir(path.join(folder, '.verdandi'))).not.toContain('views.yaml')
  })
})
