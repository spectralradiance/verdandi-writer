// Everything that reads documents, for documents with several layers (PLAN.md §3c,
// Phase 8 step 5): sections split per layer, exports, AI material, search, callouts
// written in Obsidian, and section files renamed outside it.

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { layerMaterial, splitSections } from '../shared/document'
import { fieldText, finishedText, parseFieldText, undeclaredCallouts } from '../shared/layers'
import { exportMarkdown, plainLinks } from './exporter'
import { BackupStore, PathGuard } from './fileService'
import { sectionId } from '../shared/layerFiles'
import { addAttachments, convertFileToFolder, readLayerDocument, setSectionFields } from './layerDocument'
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

describe('addAttachments', () => {
  it('copies images into attachments under free names, skipping anything else', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'verdandi-images-'))
    const file = path.join(parent, 'Eras.md')
    await writeFile(file, '# One\nFirst.\n')
    const { folder } = await convertFileToFolder(file)
    const source = await mkdtemp(path.join(tmpdir(), 'verdandi-image-source-'))
    await writeFile(path.join(source, 'map.png'), 'png bytes')
    await writeFile(path.join(source, 'notes.txt'), 'not an image')
    expect(await addAttachments(folder, [path.join(source, 'map.png'), path.join(source, 'notes.txt'), path.join(source, 'missing.png')])).toEqual(['map.png'])
    expect(await addAttachments(folder, [path.join(source, 'map.png')])).toEqual(['map 2.png'])
    expect(await readFile(path.join(folder, 'attachments', 'map 2.png'), 'utf8')).toBe('png bytes')
    await expect(addAttachments(source, [path.join(source, 'map.png')])).rejects.toThrow(/not a document folder/)
  })
})

describe('section fields edited in the app', () => {
  it('reads and writes field values as one line each', () => {
    expect(fieldText(['act-1', 'act-2'])).toBe('[act-1, act-2]')
    expect(fieldText('draft')).toBe('draft')
    expect(fieldText(3)).toBe('3')
    expect(parseFieldText('[act-1, act-2]')).toEqual(['act-1', 'act-2'])
    expect(parseFieldText(' 3 ')).toBe(3)
    expect(parseFieldText('2026-11-14')).toBe('2026-11-14')
    expect(parseFieldText('a: b')).toBe('a: b')
    expect(parseFieldText('[unclosed')).toBe('[unclosed')
    expect(parseFieldText('')).toBeNull()
  })

  it('changes a section’s fields in the main file, keeping its comments and the text', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'verdandi-fields-'))
    const folder = path.join(parent, 'Eras')
    await mkdir(folder)
    const main = path.join(folder, 'Eras.md')
    await writeFile(main, '---\nverdandi: document\n# where the draft is\nsections:\n  One: {status: idea, pov: Ana}\n---\n## One\n\nFirst.\n\n## Two\n\nSecond.\n')
    const backups = new BackupStore(await mkdtemp(path.join(tmpdir(), 'verdandi-backups-')), new PathGuard(() => [tmpdir()]))
    const before = await readLayerDocument(folder)
    const one = sectionId('One', 1)
    expect(before.fields?.[one]).toEqual({ status: 'idea', pov: 'Ana' })

    const result = await setSectionFields(folder, one, { set: { status: 'draft', tags: ['act-1'] }, remove: ['pov'] }, before.mtimeMs, backups)
    expect(result.fields).toEqual({ status: 'draft', tags: ['act-1'] })
    expect(await readFile(main, 'utf8')).toBe('---\nverdandi: document\n# where the draft is\nsections:\n  One: {status: draft, tags: [act-1]}\n---\n## One\n\nFirst.\n\n## Two\n\nSecond.\n')
    const after = await readLayerDocument(folder)
    expect(after.mtimeMs).toBe(result.mtimeMs)
    expect(after.text).toBe(before.text)

    // The token it was given is stale now; Verdandi's own keys are refused.
    await expect(setSectionFields(folder, one, { set: { status: 'done' }, remove: [] }, before.mtimeMs, backups)).rejects.toThrow(/changed on disk/)
    await expect(setSectionFields(folder, one, { set: { heading: false }, remove: [] }, result.mtimeMs, backups)).rejects.toThrow(/kept by Verdandi/)
    await expect(setSectionFields(folder, 'nope', { set: {}, remove: [] }, result.mtimeMs, backups)).rejects.toThrow(/isn’t in the files yet/)
  })
})
