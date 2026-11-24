import { describe, expect, it } from 'vitest'

import {
  assembleWorkingText, bodyKey, discoverLayers, layerFileName, parseMainFile, sectionId, splitAtHeadings, splitWorkingText, uniqueSectionNames, writeBody, writeMainYaml,
} from './layerFiles'
import { splitFrontmatter } from './layers'

const MAIN = `---
verdandi: document
layers:
  - {name: notes, kind: prose}
  - {name: outline, kind: list}
sections:
  The Last Lamp: {status: revised, tags: [act-1]}
  Fog lifts: {heading: false}
---
# Salt and Signal

An epigraph.

## The Last Lamp

The lamp at Skerrow.

### A deeper heading

Stays in the section.

## Fog lifts

The fog lifted.
`

const NOTES = `Notes on the whole book.

## The Last Lamp

Open on the lamp.
`

const OUTLINE = `## Fog lifts

- It lifts
- Ships appear

## The Last Lamp

- The routine
`

const files = (notes: string | null = NOTES, outline: string | null = OUTLINE) => new Map([['notes', notes], ['outline', outline]])

describe('splitAtHeadings', () => {
  it('splits at one level only, and not inside fenced code', () => {
    const split = splitAtHeadings('intro\n## One\na\n### Deep\n```\n## not a heading\n```\n## Two ##\nb\n', 2)
    expect(split.preamble).toEqual(['intro'])
    expect(split.sections.map((section) => section.name)).toEqual(['One', 'Two'])
    expect(split.sections[0].lines).toEqual(['a', '### Deep', '```', '## not a heading', '```'])
  })
})

describe('parseMainFile', () => {
  it('reads the level, layers with their files, and fields', () => {
    const main = parseMainFile(MAIN.replace('kind: list}', 'kind: list, file: Plan.md}'))
    expect(main.level).toBe(2)
    expect(main.layers.map((layer) => [layer.name, layer.kind, layer.file])).toEqual([['notes', 'prose', undefined], ['outline', 'list', 'Plan.md']])
    expect(main.fields['The Last Lamp']).toEqual({ status: 'revised', tags: ['act-1'] })
    expect(main.split.preamble).toEqual(['# Salt and Signal', '', 'An epigraph.', ''])
  })

  it('names layer files after the document unless a file is given', () => {
    expect(layerFileName('Salt', { name: 'notes', kind: 'prose', anchored: false })).toBe('Salt - Notes.md')
    expect(layerFileName('Salt', { name: 'notes', kind: 'prose', anchored: false, file: 'Mine' })).toBe('Mine.md')
  })
})

describe('assembleWorkingText', () => {
  it('puts the files together as the editor’s working text', () => {
    const assembled = assembleWorkingText(parseMainFile(MAIN), files())
    expect(assembled.text).toBe([
      '# Salt and Signal\n\nAn epigraph.\n\n::: notes\nNotes on the whole book.\n:::',
      `<!-- section: The Last Lamp {#${sectionId('The Last Lamp', 1)} .heading} -->`,
      'The lamp at Skerrow.\n\n### A deeper heading\n\nStays in the section.\n\n::: notes\nOpen on the lamp.\n:::\n\n::: outline\n- The routine\n:::',
      `<!-- section: Fog lifts {#${sectionId('Fog lifts', 1)}} -->`,
      'The fog lifted.\n\n::: outline\n- It lifts\n- Ships appear\n:::',
    ].join('\n'))
    expect(assembled.sections.map((section) => [section.name, section.heading, section.fields])).toEqual([
      ['The Last Lamp', true, { status: 'revised', tags: ['act-1'] }],
      ['Fog lifts', false, {}],
    ])
    expect(assembled.strays).toEqual([])
  })

  it('keeps a heading that matches no section as a stray', () => {
    const assembled = assembleWorkingText(parseMainFile(MAIN), files(`${NOTES}\n## Elsewhere\n\nKept.\n\n## Also elsewhere\n\nKept too.\n`))
    expect(assembled.strays.map((stray) => stray.name)).toEqual(['Elsewhere', 'Also elsewhere'])
    expect(assembled.text).not.toContain('Kept')
  })

  it('pairs a heading renamed in one file only with the section missing in its place', () => {
    const renamed = assembleWorkingText(parseMainFile(MAIN), files(NOTES, '## The Last Lamp\n\n- The routine\n\n## The fog lifts\n\n- It lifts\n'))
    expect(renamed.paired).toEqual([{ layer: 'outline', from: 'The fog lifts', to: 'Fog lifts' }])
    expect(renamed.strays).toEqual([])
    expect(renamed.text).toContain('The fog lifted.\n\n::: outline\n- It lifts')
  })

  it('does not pair a heading added at the end of a layer that leaves sections out', () => {
    const main = parseMainFile('---\nverdandi: document\nlayers: [notes]\n---\n## A\n\n## B\n\n## C\n')
    const assembled = assembleWorkingText(main, new Map([['notes', '## A\n\nOn A.\n\n## New\n\nA stray.\n']]))
    expect(assembled.paired).toEqual([])
    expect(assembled.strays.map((stray) => stray.name)).toEqual(['New'])
  })

  it('pairs at the end when the layer has every other section', () => {
    const main = parseMainFile('---\nverdandi: document\nlayers: [notes]\n---\n## A\n\n## B\n')
    const assembled = assembleWorkingText(main, new Map([['notes', '## A\n\nOn A.\n\n## Bee\n\nOn B.\n']]))
    expect(assembled.paired).toEqual([{ layer: 'notes', from: 'Bee', to: 'B' }])
  })

  it('does not pair when the missing section is elsewhere', () => {
    // "Elsewhere" sits before The Last Lamp in notes; the only section missing from notes is after it.
    const notes = '## Elsewhere\n\nKept.\n\n## The Last Lamp\n\nOpen.\n'
    const assembled = assembleWorkingText(parseMainFile(MAIN), files(notes, null))
    expect(assembled.paired).toEqual([])
    expect(assembled.strays.map((stray) => stray.name)).toEqual(['Elsewhere'])
  })

  it('matches sections of the same name in order', () => {
    const main = parseMainFile('---\nverdandi: document\nlayers: [notes]\n---\n## Interlude\n\nOne.\n\n## Interlude\n\nTwo.\n')
    const assembled = assembleWorkingText(main, new Map([['notes', '## Interlude\n\nFirst note.\n\n## Interlude\n\nSecond note.\n']]))
    expect(assembled.sections.map((section) => section.id)).toEqual([sectionId('Interlude', 1), sectionId('Interlude', 2)])
    expect(assembled.text).toMatch(/One\.\n\n::: notes\nFirst note\.[\s\S]*Two\.\n\n::: notes\nSecond note\./)
  })

  it('lists fields whose section is gone', () => {
    const assembled = assembleWorkingText(parseMainFile(MAIN.replace('Fog lifts: {heading: false}', 'Gone: {status: draft}')), files())
    expect(assembled.orphanFields).toEqual(['Gone'])
  })

  it('reads a heading deleted from a layer file as part of the section above', () => {
    const assembled = assembleWorkingText(parseMainFile(MAIN), files(null, OUTLINE.replace('\n## The Last Lamp\n', '\n')))
    expect(assembled.text).toMatch(/::: outline\n- It lifts\n- Ships appear\n+- The routine\n:::/)
  })
})

describe('splitWorkingText', () => {
  it('splits the working text back, every block of a layer joined', () => {
    const text = 'Title\n\n::: notes\nWhole book.\n:::\n<!-- section: One {#a .heading} -->\nPara one.\n\n::: notes\nOn para one.\n:::\n\nPara two.\n\n::: notes\nOn para two.\n:::\n<!-- section: Two {#b} -->\nText.'
    const split = splitWorkingText(text, ['notes'])
    expect(split.preamble).toEqual({ text: ['Title'], layers: { notes: ['Whole book.'] } })
    expect(split.sections).toEqual([
      { id: 'a', name: 'One', heading: true, text: ['Para one.', '', 'Para two.'], layers: { notes: ['On para one.', '', 'On para two.'] } },
      { id: 'b', name: 'Two', heading: false, text: ['Text.'], layers: {} },
    ])
  })

  it('round-trips: files, working text, files', () => {
    const main = parseMainFile(MAIN)
    const assembled = assembleWorkingText(main, files())
    const split = splitWorkingText(assembled.text, ['notes', 'outline'])
    const body = writeBody(2, split.preamble.text, split.sections.map((section) => ({ name: section.name, lines: section.text })))
    expect(body).toBe(splitFrontmatter(MAIN).body)
    const notes = writeBody(2, split.preamble.layers.notes ?? [], split.sections.filter((section) => section.layers.notes).map((section) => ({ name: section.name, lines: section.layers.notes })))
    expect(notes).toBe(NOTES)
    const outline = writeBody(2, [], split.sections.filter((section) => section.layers.outline).map((section) => ({ name: section.name, lines: section.layers.outline })))
    // The main file decides the order; the content is the same.
    expect(bodyKey(outline, 2, false)).toBe(bodyKey(OUTLINE, 2, false))
    expect(bodyKey(outline, 2, true)).not.toBe(bodyKey(OUTLINE, 2, true))
  })

  it('tells spacing apart from content', () => {
    expect(bodyKey('## A\n\n\ntext\n\n\n## B\n', 2, true)).toBe(bodyKey('## A\ntext\n## B', 2, true))
    expect(bodyKey('## A\ntext\n', 2, true)).not.toBe(bodyKey('## A\ntext!\n', 2, true))
  })
})

describe('writeMainYaml', () => {
  it('changes fields and layers, keeping comments and other keys', () => {
    const yaml = '# mine\nverdandi: document\ntags: [novel]\nlayers:\n  - {name: notes, kind: prose}\n'
    const next = writeMainYaml(yaml, { fields: { One: { status: 'draft' }, Two: {} } })
    expect(next).toBe('# mine\nverdandi: document\ntags: [novel]\nlayers:\n  - {name: notes, kind: prose}\nsections:\n  One: {status: draft}\n')
    expect(writeMainYaml(next, { fields: { One: { status: 'draft' } }, layers: [{ name: 'notes', kind: 'prose', anchored: false }] })).toBe(next)
    expect(writeMainYaml(next, { fields: {} })).not.toContain('sections')
  })

  it('writes the section level only when it is not the default', () => {
    expect(writeMainYaml(null, { level: 1 })).toBe('verdandi: document\nsection-level: 1\n')
    expect(writeMainYaml(null, { level: 2 })).toBe('verdandi: document\n')
  })
})

describe('uniqueSectionNames', () => {
  it('gives a repeated new name a suffix, and leaves sections read with the same name alone', () => {
    const known = new Map([['a', 'Interlude'], ['b', 'Interlude'], ['c', 'Storm']])
    expect(uniqueSectionNames([
      { id: 'a', name: 'Interlude' }, { id: 'b', name: 'Interlude' }, { id: null, name: 'Storm' }, { id: 'c', name: 'Storm' }, { id: 'x', name: 'Interlude' },
    ], known)).toEqual(['Interlude', 'Interlude', 'Storm (2)', 'Storm', 'Interlude (2)'])
  })
})

describe('discoverLayers', () => {
  it('finds the layer files no declared layer reads', () => {
    const declared = [{ name: 'notes', kind: 'prose' as const, anchored: false }]
    expect(discoverLayers('Eras', ['Eras.md', 'Eras - Notes.md', 'Eras - Story beats.md', 'Eras - Old.txt', 'Other - X.md'], declared))
      .toEqual([{ name: 'story-beats', kind: 'prose', anchored: false, file: 'Eras - Story beats.md', discovered: true, label: 'Story beats' }])
  })
})
