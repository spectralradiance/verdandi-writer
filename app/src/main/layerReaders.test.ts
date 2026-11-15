// Everything that reads documents, for documents with several layers (PLAN.md §3b,
// Phase 8 step 5): sections split per layer, exports, AI material, search, callouts
// written in Obsidian, and section files renamed outside it.

import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { layerMaterial, splitSections } from '../shared/document'
import { finishedText, undeclaredCallouts } from '../shared/layers'
import { exportMarkdown, plainLinks } from './exporter'
import { BackupStore, PathGuard } from './fileService'
import { convertFileToFolder, readFolderDocument, SECTIONS_FILE, writeFolderDocument } from './folderDocument'
import { searchableText } from './searchIndex'

const LAYERS = ['notes', 'outline']

const TEXT = [
  '<!-- section: Dawn {#a1 .heading} -->',
  'The sun rose.',
  '',
  '::: notes',
  'Make it slow.',
  ':::',
  '',
  'Birds woke.',
  '',
  '::: notes',
  'Which birds?',
  ':::',
  '',
  '::: outline',
  '- sunrise',
  '- birds',
  ':::',
  '<!-- section: Dusk {#b2} -->',
  'It got dark.',
  '',
].join('\n')

describe('sections per layer', () => {
  it('splits each section’s layers apart, with their word counts', () => {
    const [dawn, dusk] = splitSections(TEXT, LAYERS)
    expect(dawn.layers).toEqual({ notes: 'Make it slow.\n\nWhich birds?', outline: '- sunrise\n- birds' })
    expect(dawn.layerWords).toEqual({ notes: 5, outline: 2 })
    expect(dawn.notesWords).toBe(7)
    expect(dusk.layers).toEqual({})
    expect(dusk.layerWords).toEqual({})
  })

  it('keeps a one-file document’s notes as its one layer', () => {
    const [section] = splitSections('# A\ntext\n\n::: notes\nnote\n:::\n')
    expect(section.layers).toEqual({ notes: 'note' })
  })

  it('gives a model each layer under its own heading', () => {
    const [dawn] = splitSections(TEXT, LAYERS)
    expect(layerMaterial(dawn, LAYERS)).toBe('### Notes\n\nMake it slow.\n\nWhich birds?\n\n### Outline\n\n- sunrise\n- birds')
    expect(layerMaterial(dawn, ['notes'])).toBe(dawn.notes)
    expect(layerMaterial(dawn, null)).toBe(dawn.notes)
  })

  it('gives the finished text without layers or markers, sections kept apart', () => {
    // Dusk has no heading, and Dawn ends with blocks: its last paragraph still doesn't run into Dusk's first.
    expect(finishedText(TEXT, LAYERS).trim()).toBe('# Dawn\nThe sun rose.\n\nBirds woke.\n\nIt got dark.')
  })
})

describe('exporting layers', () => {
  it('exports one layer under each section’s heading', () => {
    expect(exportMarkdown(TEXT, 'Day', { content: 'layer:outline', includeTitle: false }, LAYERS)).toEqual({
      markdown: '# Dawn\n\n- sunrise\n- birds\n',
      sections: 1,
      skipped: ['Dusk'],
    })
  })

  it('exports every layer, each under a subheading when a section has more than one', () => {
    expect(exportMarkdown(TEXT, 'Day', { content: 'notes', includeTitle: true }, LAYERS).markdown)
      .toBe('# Day\n\n## Dawn\n\n### Notes\n\nMake it slow.\n\nWhich birds?\n\n### Outline\n\n- sunrise\n- birds\n')
  })

  it('exports a one-file document’s notes as its notes layer', () => {
    expect(exportMarkdown('# A\ntext\n\n::: notes\nnote\n:::\n', 'Doc', { content: 'layer:notes', includeTitle: false }).markdown)
      .toBe('# A\n\nnote\n')
  })
})

describe('plainLinks', () => {
  it('turns image embeds into images and links into their text', () => {
    const resolve = (name: string) => `attachments/${name}`
    expect(plainLinks('![[map.png]] and ![[map.png|The map]] at ![[map.png|300]]', resolve))
      .toBe('![map](<attachments/map.png>) and ![The map](<attachments/map.png>) at ![map](<attachments/map.png>)')
    expect(plainLinks('See [[The First Era]] and [[The Second Era|the next one]], or [[Eras#Dawn]].'))
      .toBe('See The First Era and the next one, or Eras.')
  })

  it('leaves note embeds and code alone', () => {
    expect(plainLinks('![[Other note]]')).toBe('![[Other note]]')
    expect(plainLinks('`[[code]]` and [[link]]')).toBe('`[[code]]` and link')
    expect(plainLinks('```\n![[map.png]]\n```')).toBe('```\n![[map.png]]\n```')
  })
})

describe('searchableText', () => {
  it('reads markers as section names and leaves out block lines, line for line', () => {
    const searchable = searchableText(TEXT, LAYERS)
    const lines = searchable.split('\n')
    expect(lines).toHaveLength(TEXT.split('\n').length)
    expect(lines[0]).toBe('Dawn')
    expect(lines[3]).toBe('')
    expect(lines[4]).toBe('Make it slow.')
    expect(searchable).not.toMatch(/:::|section:|#a1/)
  })
})

describe('undeclaredCallouts', () => {
  it('finds callout types that could be layers, once each, leaving out Obsidian’s own', () => {
    const text = ['Text.', '> [!beats]', '> one', '', '> [!warning]', '> careful', '', '> [!Beats]-', '', '::: notes', '> [!research]', ':::', '```', '> [!code]', '```', '> [!images]'].join('\n')
    expect(undeclaredCallouts(text, ['notes'])).toEqual(['beats', 'images'])
    expect(undeclaredCallouts(text, ['notes', 'beats', 'images'])).toEqual([])
  })
})

describe('section files renamed outside Obsidian', () => {
  const backups = async () => new BackupStore(await mkdtemp(path.join(tmpdir(), 'verdandi-backups-')), new PathGuard(() => [tmpdir()]))
  const trash = (target: string) => rm(target, { force: true })
  const ids = () => {
    let count = 0
    return () => `id${(count += 1)}`
  }

  async function converted() {
    const parent = await mkdtemp(path.join(tmpdir(), 'verdandi-stale-'))
    const file = path.join(parent, 'Eras.md')
    await writeFile(file, '# One\nFirst.\n\n# Two\nSecond.\n\n# Three\nThird.\n')
    return (await convertFileToFolder(file, ids())).folder
  }

  it('remembers which file each section is in', async () => {
    const folder = await converted()
    const remembered = await readFile(path.join(folder, SECTIONS_FILE), 'utf8')
    expect(remembered).toMatch(/^# /)
    expect(remembered).toContain('id1: One')
    expect(remembered).toContain('id3: Three')
  })

  it('finds a renamed file by the id remembered for its embed, in its place', async () => {
    const folder = await converted()
    await rename(path.join(folder, 'One.md'), path.join(folder, 'Uno.md'))
    await rename(path.join(folder, 'Three.md'), path.join(folder, 'Tres.md'))
    const document = await readFolderDocument(folder)
    expect(splitSections(document.text, ['notes']).map((section) => section.title)).toEqual(['Uno', 'Two', 'Tres'])

    // The next save puts the new names in the document note, and remembers them.
    const result = await writeFolderDocument(folder, {
      path: folder, text: `${document.text}\nMore.`, format: document.format, expectedMtimeMs: document.mtimeMs,
    }, await backups(), trash)
    expect(result.ok).toBe(true)
    expect(await readFile(path.join(folder, 'Eras.md'), 'utf8')).toContain('![[Uno]]\n![[Two]]\n![[Tres]]')
    expect(await readFile(path.join(folder, SECTIONS_FILE), 'utf8')).toContain('id1: Uno')
  })

  it('without a remembered id, matches one stale embed to the one file no embed lists', async () => {
    const folder = await converted()
    await rm(path.join(folder, SECTIONS_FILE))
    await rename(path.join(folder, 'Two.md'), path.join(folder, 'Deux.md'))
    const document = await readFolderDocument(folder)
    expect(splitSections(document.text, ['notes']).map((section) => section.title)).toEqual(['One', 'Deux', 'Three'])
  })

  it('leaves out a stale embed it can’t match', async () => {
    const folder = await converted()
    await rm(path.join(folder, SECTIONS_FILE))
    await rename(path.join(folder, 'One.md'), path.join(folder, 'Uno.md'))
    await rename(path.join(folder, 'Two.md'), path.join(folder, 'Deux.md'))
    const document = await readFolderDocument(folder)
    expect(splitSections(document.text, ['notes']).map((section) => section.title)).toEqual(['Three'])
  })
})
