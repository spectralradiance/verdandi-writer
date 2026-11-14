import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { parseDocumentNote } from '../shared/layers'
import { convertFileToFolder, ORIGINAL_DIR, undoConversion } from './folderDocument'

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
