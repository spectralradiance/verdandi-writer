import { describe, expect, it } from 'vitest'

import {
  blocksToCallouts, calloutsToBlocks, classifyLayerLines, convertOneFile, fileNameFor, isDocumentNote, joinFrontmatter,
  looksLikeVerdandiDocument, newDocumentNote, NOTES_LAYER, parseDocumentNote, parseLayers, parseSectionFile, readFields,
  setFields, splitFrontmatter, uniqueName, writeDocumentNote, writeSectionFile,
} from './layers'

const LAYERS = ['notes', 'outline', 'images']

describe('frontmatter', () => {
  it('splits and joins back exactly', () => {
    for (const text of ['---\nid: 7f3a\ntags: [a]\n---\nBody\n', '---\n---\nBody', 'No frontmatter\n---\n', '']) {
      const { yaml, body } = splitFrontmatter(text)
      expect(joinFrontmatter(yaml, body)).toBe(text)
    }
    expect(splitFrontmatter('Text\n---\nid: 1\n---\n').yaml).toBeNull()
  })

  it('edits fields, keeping comments and order', () => {
    const yaml = '# drafted in March\nstatus: draft\ntags: [act-1]\n'
    expect(setFields(yaml, { status: 'done', id: '0042' })).toBe('# drafted in March\nstatus: done\ntags: [act-1]\nid: "0042"\n')
    expect(setFields('a: 1\nb: 2\n', { a: undefined })).toBe('b: 2\n')
    expect(setFields(null, {})).toBeNull()
    expect(setFields(null, { title: 'Era: Dawn', heading: false })).toBe('title: "Era: Dawn"\nheading: false\n')
    expect(readFields('id: "0042"\n').id).toBe('0042')
    expect(readFields('not: [valid\n')).toEqual({})
    expect(() => setFields('not: [valid\n', { a: 1 })).toThrow(/not valid YAML/)
  })
})

describe('layers', () => {
  it('reads the declared layers', () => {
    expect(parseLayers([
      { name: 'notes', kind: 'prose', anchored: true },
      'Research',
      { name: 'images', kind: 'gallery' },
      { name: 'text' },
      { name: 'bad name' },
      { name: 'notes', kind: 'list' },
      { name: 'beats', kind: 'unknown' },
    ])).toEqual([
      { name: 'notes', kind: 'prose', anchored: true },
      { name: 'research', kind: 'prose', anchored: false },
      { name: 'images', kind: 'gallery', anchored: false },
      { name: 'beats', kind: 'prose', anchored: false },
    ])
    expect(parseLayers('notes')).toEqual([])
  })
})

describe('callouts and blocks', () => {
  const disk = [
    'The text of the section.',
    '',
    '> [!notes]',
    '> A note on the paragraph above.',
    '>',
    '> > A quote inside the note.',
    '',
    'More text.',
    '',
    '> [!warning] An ordinary callout',
    '> stays as text.',
    '',
    '```',
    '> [!notes]',
    '> inside code',
    '```',
    '',
    '> [!Outline]- Beats',
    '> - first beat',
    '> - second beat',
    '',
  ].join('\n')

  const working = [
    'The text of the section.',
    '',
    '::: notes',
    'A note on the paragraph above.',
    '',
    '> A quote inside the note.',
    ':::',
    '',
    'More text.',
    '',
    '> [!warning] An ordinary callout',
    '> stays as text.',
    '',
    '```',
    '> [!notes]',
    '> inside code',
    '```',
    '',
    '::: Outline - Beats',
    '- first beat',
    '- second beat',
    ':::',
    '',
  ].join('\n')

  it('turns layer callouts into blocks, and back exactly', () => {
    expect(calloutsToBlocks(disk, LAYERS)).toBe(working)
    expect(blocksToCallouts(working, LAYERS)).toBe(disk)
  })

  it('keeps the fold sign and title of a callout', () => {
    for (const header of ['> [!notes]', '> [!notes]-', '> [!notes]+ Open', '> [!notes] Title', '> [!notes]-Tight', '> [!my-layer]--x']) {
      const text = `${header}\n> body`
      expect(blocksToCallouts(calloutsToBlocks(text, ['notes', 'my-layer']), ['notes', 'my-layer'])).toBe(text)
    }
  })

  it('only tidies the quote marks of hand-written callouts', () => {
    expect(blocksToCallouts(calloutsToBlocks('>[!notes]\n>tight\n  > spaced', LAYERS), LAYERS)).toBe('> [!notes]\n> tight\n> spaced')
  })

  it('keeps callouts apart when blocks touch', () => {
    const text = '::: notes\na\n:::\n::: notes\nb\n:::\n> a quote'
    expect(blocksToCallouts(text, LAYERS)).toBe('> [!notes]\n> a\n\n> [!notes]\n> b\n\n> a quote')
    expect(calloutsToBlocks(blocksToCallouts(text, LAYERS), LAYERS)).toBe('::: notes\na\n:::\n\n::: notes\nb\n:::\n\n> a quote')
  })

  it('round-trips working text with empty, unclosed and code-holding blocks', () => {
    const closed = '::: notes\n\nx\n\n```\n:::\n```\n:::\nText'
    expect(calloutsToBlocks(blocksToCallouts(closed, LAYERS), LAYERS)).toBe(closed)
    // An unclosed block runs to the end, and comes back closed.
    expect(calloutsToBlocks(blocksToCallouts('Text\n\n::: notes\ntyping', LAYERS), LAYERS)).toBe('Text\n\n::: notes\ntyping\n:::')
  })

  it('classifies lines by layer', () => {
    const roles = classifyLayerLines('Text\n::: notes\nn\n:::\n::: other\no\n:::\n::: Outline -\n- a'.split('\n'), LAYERS)
    expect(roles.map((line) => `${line.role}:${line.layer ?? ''}`)).toEqual([
      'text:', 'open:notes', 'layer:notes', 'close:notes', 'text:', 'text:', 'text:', 'open:outline', 'layer:outline',
    ])
  })
})

describe('section files', () => {
  it('reads the id, title and heading, and writes the file back', () => {
    const source = '---\nid: 7f3a\ntitle: "Era: Dawn"\nheading: false\nstatus: draft\n---\nText.\n\n> [!notes]\n> A note.\n'
    const file = parseSectionFile(source, LAYERS)
    expect(file).toMatchObject({ id: '7f3a', title: 'Era: Dawn', heading: false, text: 'Text.\n\n::: notes\nA note.\n:::\n' })
    expect(writeSectionFile(file, LAYERS)).toBe(source)
    expect(parseSectionFile('Just text.', LAYERS)).toEqual({ yaml: null, id: null, title: null, heading: true, text: 'Just text.' })
  })
})

describe('document notes', () => {
  const note = [
    '---',
    'verdandi: document',
    'layers:',
    '  - {name: notes, kind: prose, anchored: true}',
    '  - {name: outline, kind: list}',
    '---',
    'A note about the document.',
    '',
    '![[The First Era]]',
    '![[The Second Era.md|Second]]',
    '![[Third#Part]]',
    '',
    '```',
    '![[Not a section]]',
    '```',
    '',
  ].join('\n')

  it('reads the layers and the sections in order', () => {
    expect(isDocumentNote(note)).toBe(true)
    expect(isDocumentNote('# Just a note\n')).toBe(false)
    const parsed = parseDocumentNote(note)
    expect(parsed.layers).toEqual([NOTES_LAYER, { name: 'outline', kind: 'list', anchored: false }])
    expect(parsed.sections).toEqual(['The First Era', 'The Second Era', 'Third'])
  })

  it('reorders sections, keeping how each embed was written and every other line', () => {
    const moved = writeDocumentNote(note, { sections: ['Third', 'The First Era', 'New'] })
    expect(moved).toBe(note.replace('![[The First Era]]\n![[The Second Era.md|Second]]\n![[Third#Part]]', '![[Third#Part]]\n![[The First Era]]\n![[New]]'))
    expect(writeDocumentNote(note, { sections: parseDocumentNote(note).sections })).toBe(note)
  })

  it('writes the layers as one line each', () => {
    const changed = writeDocumentNote(note, { layers: [NOTES_LAYER, { name: 'images', kind: 'gallery', anchored: false }] })
    expect(splitFrontmatter(changed).yaml).toBe('verdandi: document\nlayers:\n  - {name: notes, kind: prose, anchored: true}\n  - {name: images, kind: gallery}\n')
  })

  it('starts a new document note', () => {
    expect(newDocumentNote([NOTES_LAYER], ['One', 'Two'])).toBe(
      '---\nverdandi: document\nlayers:\n  - {name: notes, kind: prose, anchored: true}\n---\n![[One]]\n![[Two]]\n',
    )
  })
})

describe('file names', () => {
  it('keeps titles readable on every system and in Obsidian links', () => {
    expect(fileNameFor('1.1 The First Era')).toBe('1.1 The First Era')
    expect(fileNameFor('Era: Dawn')).toBe('Era - Dawn')
    expect(fileNameFor('Why? [draft] #2 | "quoted"')).toBe("Why draft 2 - 'quoted'")
    expect(fileNameFor('Before/After')).toBe('Before-After')
    expect(fileNameFor('...hidden.')).toBe('hidden')
    expect(fileNameFor('   ')).toBe('Untitled')
    expect(fileNameFor('CON')).toBe('CON section')
  })

  it('numbers names that are taken, ignoring case', () => {
    const taken = new Set(['eras'])
    expect(['Eras', 'One', 'one', 'One'].map((name) => uniqueName(name, taken))).toEqual(['Eras 2', 'One', 'one 2', 'One 3'])
  })
})

describe('converting a one-file document', () => {
  const ids = () => {
    let count = 0
    return () => `id${(count += 1)}`
  }

  const source = [
    'Some opening words.',
    '',
    '::: notes',
    'Sources for the whole piece.',
    ':::',
    '',
    '# Eras',
    'The first part.',
    '',
    '::: notes',
    'A note on it.',
    '',
    'Two paragraphs.',
    ':::',
    '',
    'After the note.',
    '',
    '<!-- section: Residue -->',
    '',
    'A named section.',
    '',
    '# Era: Dawn',
    '## A subheading',
    'Text.',
    '',
    '# Era: Dawn',
    '',
  ].join('\n')

  it('makes a document note and one file per section', () => {
    const converted = convertOneFile(source, 'Eras', ids())
    expect(converted.sections.map((section) => section.name)).toEqual(['Introduction', 'Eras 2', 'Residue', 'Era - Dawn', 'Era - Dawn 2'])
    expect(converted.note).toBe(
      '---\nverdandi: document\nlayers:\n  - {name: notes, kind: prose, anchored: true}\n---\n'
      + '![[Introduction]]\n![[Eras 2]]\n![[Residue]]\n![[Era - Dawn]]\n![[Era - Dawn 2]]\n',
    )
    expect(converted.sections.map((section) => section.text)).toEqual([
      '---\nid: id1\nheading: false\n---\nSome opening words.\n\n> [!notes]\n> Sources for the whole piece.\n',
      '---\nid: id2\ntitle: Eras\n---\nThe first part.\n\n> [!notes]\n> A note on it.\n>\n> Two paragraphs.\n\nAfter the note.\n',
      '---\nid: id3\nheading: false\n---\nA named section.\n',
      '---\nid: id4\ntitle: "Era: Dawn"\n---\n## A subheading\nText.\n',
      '---\nid: id5\ntitle: "Era: Dawn"\n---\n',
    ])
  })

  it('reads back as the same sections, titles and notes', () => {
    const converted = convertOneFile(source, 'Eras', ids())
    const files = converted.sections.map((section) => parseSectionFile(section.text, ['notes']))
    expect(files.map((file) => file.title)).toEqual([null, 'Eras', null, 'Era: Dawn', 'Era: Dawn'])
    expect(files.map((file) => file.heading)).toEqual([false, true, false, true, true])
    expect(files[1].text).toBe('The first part.\n\n::: notes\nA note on it.\n\nTwo paragraphs.\n:::\n\nAfter the note.\n')
  })

  it('gives a file without headings one section', () => {
    expect(convertOneFile('Only words.\n', 'Doc', ids()).sections).toEqual([
      { name: 'Introduction', text: '---\nid: id1\nheading: false\n---\nOnly words.\n' },
    ])
    expect(convertOneFile('', 'Doc', ids()).sections.map((section) => section.name)).toEqual(['Introduction'])
  })

  it('converts only files that already use notes blocks or section markers', () => {
    expect(looksLikeVerdandiDocument(source)).toBe(true)
    expect(looksLikeVerdandiDocument('# A note\n\n<!-- section: B -->\n')).toBe(true)
    expect(looksLikeVerdandiDocument('# An ordinary note\n\n> [!notes]\n> in Obsidian\n')).toBe(false)
  })
})
