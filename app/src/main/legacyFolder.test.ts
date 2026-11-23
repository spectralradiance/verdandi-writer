import { mkdir, mkdtemp, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { splitSections } from '../shared/document'
import { sectionId } from '../shared/layerFiles'
import { CONVERTED_DIR, readDocument, readLayerDocument } from './layerDocument'
import { isLegacyFolder, readFolderDocument } from './legacyFolder'

/** A document folder in the earlier format (§3b): a document note and a file per section. */
async function legacy() {
  const parent = await mkdtemp(path.join(tmpdir(), 'verdandi-legacy-'))
  const folder = path.join(parent, 'Eras')
  await mkdir(folder)
  const files: Record<string, string> = {
    'Eras.md': '---\nverdandi: document\nlayers:\n  - {name: notes, kind: prose, anchored: true}\n  - {name: outline, kind: list}\n---\n![[One]]\n![[Two]]\n![[Coda - End]]\n',
    'One.md': '---\nid: a1\nstatus: draft\n---\nFirst paragraph.\n\n> [!notes]\n> On the first paragraph.\n\nSecond paragraph.\n\n> [!notes]\n> On the second.\n\n> [!outline]\n> - opening\n',
    'Two.md': '---\nid: b2\nheading: false\n---\nA scene.\n\n## A heading inside the section\n\nMore.\n',
    'Coda - End.md': '---\nid: c3\ntitle: "Coda: End"\ntags: [act-3]\n---\nThe end.\n',
  }
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(folder, name), text)
  return folder
}

describe('a document folder in the earlier format', () => {
  it('is read as it is for search and stats, without converting it', async () => {
    const folder = await legacy()
    expect(await isLegacyFolder(folder)).toBe(true)
    const document = await readDocument(folder)
    expect(splitSections(document.text, ['notes', 'outline']).map((section) => section.title)).toEqual(['One', 'Two', 'Coda: End'])
    expect(await isLegacyFolder(folder)).toBe(true)
    expect(document.fields?.a1).toEqual({ status: 'draft' })
  })

  it('finds a section file renamed outside Obsidian when one embed and one file are left', async () => {
    const folder = await legacy()
    await rename(path.join(folder, 'Two.md'), path.join(folder, 'Deux.md'))
    const document = await readFolderDocument(folder)
    expect(splitSections(document.text, ['notes', 'outline']).map((section) => section.title)).toEqual(['One', 'Deux', 'Coda: End'])
  })

  it('converts once when several reads arrive together, keeping a file in the way', async () => {
    const folder = await legacy()
    await writeFile(path.join(folder, 'Eras - Notes.md'), 'Left here by hand.\n')
    const reads = await Promise.all([1, 2, 3].map(() => readDocument(folder, false, true)))
    expect(reads.filter((read) => read.converted)).toHaveLength(1)
    expect(new Set(reads.map((read) => read.text)).size).toBe(1)
    expect((await readdir(path.join(folder, CONVERTED_DIR))).sort()).toEqual(['Coda - End.md', 'Eras - Notes.md', 'Eras.md', 'One.md', 'Two.md'])
    expect(await readFile(path.join(folder, CONVERTED_DIR, 'Eras - Notes.md'), 'utf8')).toBe('Left here by hand.\n')
    expect(await readFile(path.join(folder, 'Eras - Notes.md'), 'utf8')).toContain('On the first paragraph.')
  })

  it('converts to layer files when the editor opens it, keeping the earlier files', async () => {
    const folder = await legacy()
    const document = await readDocument(folder, false, true)
    expect(document.converted).toBe(CONVERTED_DIR)
    expect(await isLegacyFolder(folder)).toBe(false)
    expect((await readdir(folder)).sort()).toEqual(['.verdandi', 'Eras - Notes.md', 'Eras - Outline.md', 'Eras.md'])
    expect((await readdir(path.join(folder, CONVERTED_DIR))).sort()).toEqual(['Coda - End.md', 'Eras.md', 'One.md', 'Two.md'])

    // A heading at level 2 is inside a section, so sections are level 1.
    expect(await readFile(path.join(folder, 'Eras.md'), 'utf8')).toBe([
      '---',
      'verdandi: document',
      'layers:',
      '  - {name: notes, kind: prose}',
      '  - {name: outline, kind: list}',
      'section-level: 1',
      'sections:',
      '  One: {status: draft}',
      '  Two: {heading: false}',
      '  "Coda: End": {tags: [act-3]}',
      '---',
      '# One',
      '',
      'First paragraph.',
      '',
      'Second paragraph.',
      '',
      '# Two',
      '',
      'A scene.',
      '',
      '## A heading inside the section',
      '',
      'More.',
      '',
      '# Coda: End',
      '',
      'The end.',
      '',
    ].join('\n'))
    // Anchored notes join the end of their section's notes, in order.
    expect(await readFile(path.join(folder, 'Eras - Notes.md'), 'utf8')).toBe('# One\n\nOn the first paragraph.\n\nOn the second.\n')
    expect(await readFile(path.join(folder, 'Eras - Outline.md'), 'utf8')).toBe('# One\n\n- opening\n')

    const reopened = await readLayerDocument(folder)
    expect(reopened.converted).toBeUndefined()
    expect(reopened.fields?.[sectionId('Coda: End', 1)]).toEqual({ tags: ['act-3'] })
    const sections = splitSections(reopened.text, ['notes', 'outline'])
    expect(sections.map((section) => section.title)).toEqual(['One', 'Two', 'Coda: End'])
    expect(sections[1].output).toContain('## A heading inside the section')
  })
})
