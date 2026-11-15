import { ChangeSet, Text } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import {
  applyChange, changedRun, continuedName, deleteSection, fromSectionOffset, isFolderText, joinSections, mergeIntoPrevious, moveSection, partition, project,
  type Projection, renameSection, sectionText, sectionTitle, setSectionHeading, shownLineNumbers, showsPreamble, splitFromLayer, splitSection,
  toSectionOffset,
} from './sectionModel'

describe('named sections', () => {
  const text = '# One\nFirst.\n\n<!-- section: Two -->\n\nSecond paragraph.\n\n::: notes\nn\n:::\n\n# Three\nThird.'

  it('hides the marker and the blank lines after it from the text side', () => {
    const sections = partition(text)
    expect(sections.map((section) => [section.title, section.named])).toEqual([['One', false], ['Two', true], ['Three', false]])
    const two = project(sections[1].text, 'output')
    expect(two.text).toBe('Second paragraph.')
    expect(sectionText(two)).toBe(sections[1].text)
    expect(sectionTitle(sections[1].text)).toBe('Two')
  })

  it('renames a name or a heading', () => {
    expect(renameSection(text, 1, 'Second')).toContain('<!-- section: Second -->')
    expect(renameSection(text, 0, 'Uno')).toMatch(/^# Uno\n/)
  })

  it('switches between a heading and a name', () => {
    const asHeading = setSectionHeading(text, 1, true)!
    expect(asHeading).toContain('\n# Two\n')
    expect(partition(asHeading).map((section) => section.named)).toEqual([false, false, false])
    expect(setSectionHeading(asHeading, 1, false)).toBe(text)
  })

  it('merges a section into the previous one, keeping a heading as a subheading', () => {
    expect(partition(mergeIntoPrevious(text, 1)!).map((section) => section.title)).toEqual(['One', 'Three'])
    expect(mergeIntoPrevious(text, 1)).toContain('First.\n\nSecond paragraph.')
    expect(mergeIntoPrevious(text, 2)).toContain('\n## Three\nThird.')
    expect(mergeIntoPrevious(text, 0)).toBeNull()
  })

  it('deletes and moves sections', () => {
    expect(partition(deleteSection(text, 1)!).map((section) => section.title)).toEqual(['One', 'Three'])
    expect(partition(moveSection(text, 1, 1)!).map((section) => section.title)).toEqual(['One', 'Three', 'Two'])
    expect(partition(moveSection(text, 1, -1)!).map((section) => section.title)).toEqual(['Two', 'One', 'Three'])
  })

  it('starts a named section at a paragraph', () => {
    const split = splitSection('# A\nOne.\n\nTwo.\n', 0, 3, 'B')!
    expect(split).toBe('# A\nOne.\n\n<!-- section: B -->\nTwo.\n')
    expect(partition(split).map((section) => [section.title, section.named])).toEqual([['A', false], ['B', true]])
  })

  it('never leaves a section with only its heading', () => {
    expect(splitSection('# A\nOne.\nTwo.', 0, 1, 'B')).toBeNull()
    expect(splitSection('# A\n\nOne.\nTwo.', 0, 2, 'B')).toBeNull()
    expect(splitSection('# A\nOne.\nTwo.', 0, 2, 'B')).toBe('# A\nOne.\n\n<!-- section: B -->\nTwo.')
    expect(splitSection('Intro.\nMore.', 0, 1, 'B')).toBe('Intro.\n\n<!-- section: B -->\nMore.')
  })

  it('makes a selection its own section and continues the rest under the old name', () => {
    const source = '# A\nOne.\nTwo.\n\n::: notes\nn\n:::\nThree.\nFour.'
    const split = splitSection(source, 0, 2, 'B', { line: 7, name: continuedName('A') })!
    expect(split).toBe('# A\nOne.\n\n<!-- section: B -->\nTwo.\n\n::: notes\nn\n:::\n\n<!-- section: A (continued) -->\nThree.\nFour.')
    expect(partition(split).map((section) => section.title)).toEqual(['A', 'B', 'A (continued)'])
    // A selection that runs to the end of the section needs no continuation.
    expect(splitSection('# A\nOne.\nTwo.\n', 0, 2, 'B', { line: 3, name: 'C' })).toBe('# A\nOne.\n\n<!-- section: B -->\nTwo.\n')
    expect(continuedName('A (continued)')).toBe('A (continued)')
  })

  it('keeps the layers that are not anchored with the section that was split', () => {
    const layers = ['notes', 'outline']
    const source = '# A\nOne.\n\nTwo.\n\n::: notes\nn\n:::\n\nThree.\n\n::: outline\n- beat\n:::\n'
    // From the text: notes go with their paragraph, the outline stays.
    expect(splitSection(source, 0, 3, 'B', undefined, layers, ['outline']))
      .toBe('# A\nOne.\n\n::: outline\n- beat\n:::\n\n<!-- section: B -->\nTwo.\n\n::: notes\nn\n:::\n\nThree.\n')
    // With a continuation, which starts with a blank outline too.
    expect(splitSection(source, 0, 3, 'B', { line: 9, name: 'A (continued)' }, layers, ['outline']))
      .toBe('# A\nOne.\n\n::: outline\n- beat\n:::\n\n<!-- section: B -->\nTwo.\n\n::: notes\nn\n:::\n\n<!-- section: A (continued) -->\nThree.\n')
  })

  it('makes a section from lines of a layer, with blank text', () => {
    const layers = ['notes', 'outline']
    const source = '# A\nOne.\n\n::: notes\nfirst\nsecond\n:::\n\nTwo.\n\n::: outline\n- x\n- y\n:::\n\n# C\nThree.'
    const second = 5
    // One line of a notes block: the block keeps the rest.
    expect(splitFromLayer(source, 0, 'notes', second, second + 1, 'B', layers))
      .toBe('# A\nOne.\n\n::: notes\nfirst\n:::\n\nTwo.\n\n::: outline\n- x\n- y\n:::\n\n<!-- section: B -->\n::: notes\nsecond\n:::\n\n# C\nThree.')
    // The whole outline: its block goes from the section.
    expect(splitFromLayer(source, 0, 'outline', 11, 13, 'B', layers))
      .toBe('# A\nOne.\n\n::: notes\nfirst\nsecond\n:::\n\nTwo.\n\n<!-- section: B -->\n::: outline\n- x\n- y\n:::\n\n# C\nThree.')
    // Notes from two blocks, across the text between them: the text stays.
    const two = '# A\nOne.\n\n::: notes\nfirst\n:::\n\nTwo.\n\n::: notes\nsecond\n:::\n'
    expect(splitFromLayer(two, 0, 'notes', 4, 11, 'B', layers))
      .toBe('# A\nOne.\n\nTwo.\n\n<!-- section: B -->\n::: notes\nfirst\n\nsecond\n:::\n')
    expect(splitFromLayer(source, 0, 'notes', 1, 3, 'B', layers)).toBeNull()
  })
})

describe('a document folder shown as one text', () => {
  const text = '<!-- section: One {#a1 .heading} -->\nFirst.\n# Not a section\n<!-- section: Two {#b2} -->\nSecond.'

  it('splits at markers only, and knows which names are headings', () => {
    expect(isFolderText(text)).toBe(true)
    expect(partition(text).map((section) => [section.title, section.named, section.heading])).toEqual([['One', true, true], ['Two', true, false]])
  })

  it('keeps ids through renaming, and switches the heading in the marker', () => {
    expect(renameSection(text, 1, 'Deux')).toContain('<!-- section: Deux {#b2} -->')
    expect(setSectionHeading(text, 1, true)).toContain('<!-- section: Two {#b2 .heading} -->')
    expect(setSectionHeading(text, 0, false)).toMatch(/^<!-- section: One \{#a1\} -->/)
    expect(setSectionHeading(text, 0, true)).toBeNull()
  })

  it('keeps a merged heading as a subheading, and gives split sections ids', () => {
    expect(mergeIntoPrevious(text.replace('{#b2}', '{#b2 .heading}'), 1)).toContain('# Not a section\n## Two\nSecond.')
    const split = splitSection(`${text}\nMore.`, 1, 2, 'Three')!
    expect(split).toMatch(/Second\.\n\n<!-- section: Three \{#[0-9a-z]{8}\} -->\nMore\.$/)
  })
})

const doc = [
  'Intro text',
  '',
  '# One',
  'First paragraph.',
  '',
  '::: notes',
  'a note',
  ':::',
  '',
  'Second paragraph.',
  '',
  '::: notes',
  'closing note',
  ':::',
  '',
  '# Two',
  'Only text.',
  '',
].join('\n')

/** Applies an edit to a projection as an editor would: change the text, then map. */
function edit(projection: Projection, from: number, to: number, insert: string): Projection {
  const changes = ChangeSet.of({ from, to, insert }, projection.text.length)
  return applyChange(projection, changes.apply(Text.of(projection.text.split('\n'))).toString(), changes)
}

describe('partition', () => {
  it('covers every line, so joining gives the file back', () => {
    const sections = partition(doc)
    expect(sections.map((section) => section.title)).toEqual([null, 'One', 'Two'])
    expect(joinSections(sections)).toBe(doc)
  })

  it('keeps a blank preamble in the text without giving it a row', () => {
    const sections = partition('\n# A\ntext')
    expect(sections.map((section) => section.text)).toEqual(['', '# A\ntext'])
    expect(showsPreamble(sections)).toBe(false)
    expect(showsPreamble(partition('just text'))).toBe(true)
    expect(showsPreamble(partition(''))).toBe(true)
  })
})

describe('project', () => {
  const one = partition(doc)[1].text

  it('shows the output without notes, the blank lines before them or at the end', () => {
    expect(project(one, 'output').text).toBe('# One\nFirst paragraph.\n\nSecond paragraph.')
  })

  it('shows the notes alone', () => {
    expect(project(one, 'notes').text).toBe('a note\nclosing note')
  })

  it('round-trips the section exactly', () => {
    for (const section of partition(doc)) {
      expect(sectionText(project(section.text, 'output'))).toBe(section.text)
      expect(sectionText(project(section.text, 'notes'))).toBe(section.text)
    }
  })

  it('maps shown lines back to section lines', () => {
    expect(shownLineNumbers(project(one, 'output'))).toEqual([0, 1, 6, 7])
    expect(shownLineNumbers(project(one, 'notes'))).toEqual([4, 10])
  })
})

describe('applyChange', () => {
  const one = partition(doc)[1].text

  it('keeps notes in place when the text around them is edited', () => {
    const output = project(one, 'output')
    const typed = edit(output, output.text.indexOf('First') + 5, output.text.indexOf('First') + 5, ' and only')
    expect(sectionText(typed)).toBe(one.replace('First paragraph.', 'First and only paragraph.'))
  })

  it('puts new lines typed at the end of a paragraph before the notes that follow it', () => {
    const output = project(one, 'output')
    const end = output.text.indexOf('Second') - 2
    const typed = edit(output, end, end, '\nMore.')
    expect(sectionText(typed)).toContain('First paragraph.\nMore.\n\n::: notes\na note')
  })

  it('keeps notes when the line they follow is joined to the next one', () => {
    const output = project(one, 'output')
    const from = output.text.indexOf('paragraph.') + 'paragraph.'.length
    const joined = edit(output, from, output.text.indexOf('Second'), ' ')
    expect(joined.text).toBe('# One\nFirst paragraph. Second paragraph.')
    expect(sectionText(joined)).toBe('# One\nFirst paragraph. Second paragraph.\n\n::: notes\na note\n:::\n\n::: notes\nclosing note\n:::\n')
  })

  it('edits notes without touching the text', () => {
    const notes = project(one, 'notes')
    const typed = edit(notes, 0, 1, 'A')
    expect(sectionText(typed)).toBe(one.replace('a note', 'A note'))
  })

  it('starts a notes block when typing into a section without notes', () => {
    const two = partition(doc)[2].text
    const notes = project(two, 'notes')
    expect(notes.empty).toBe(true)
    const typed = edit(notes, 0, 0, 'new note')
    expect(sectionText(typed)).toBe('# Two\nOnly text.\n\n::: notes\nnew note\n:::\n')
    expect(project(sectionText(typed), 'notes').text).toBe('new note')
    expect(project(sectionText(typed), 'output').text).toBe('# Two\nOnly text.')
  })

  it('hides blank lines just inside a notes block', () => {
    const notes = project('# A\n::: notes\n\nx\n\ny\n\n:::', 'notes')
    expect(notes.text).toBe('x\n\ny')
    expect(sectionText(edit(notes, 0, 1, 'X'))).toBe('# A\n::: notes\n\nX\n\ny\n\n:::')
    expect(sectionText(edit(project('# A\n::: notes\n\n:::', 'notes'), 0, 0, 'n'))).toBe('# A\n::: notes\nn\n\n:::')
  })

  it('fills an empty notes block instead of adding another', () => {
    const notes = project('# A\ntext\n\n::: notes\n:::', 'notes')
    expect(sectionText(edit(notes, 0, 0, 'x'))).toBe('# A\ntext\n\n::: notes\nx\n:::')
  })

  it('writes the first text of an empty file', () => {
    const output = project('', 'output')
    expect(sectionText(edit(output, 0, 0, 'Hello'))).toBe('Hello\n')
  })
})

describe('offsets', () => {
  const one = partition(doc)[1].text

  it('converts between editor and section offsets', () => {
    const notes = project(one, 'notes')
    const editorOffset = notes.text.indexOf('closing')
    const sectionOffset = toSectionOffset(notes, editorOffset)
    expect(one.slice(sectionOffset, sectionOffset + 7)).toBe('closing')
    expect(fromSectionOffset(notes, sectionOffset)).toBe(editorOffset)
    expect(fromSectionOffset(notes, one.indexOf('First'))).toBeNull()
  })
})

describe('changedRun', () => {
  it('finds the run of sections that differs', () => {
    expect(changedRun(['a', 'b', 'c'], ['a', 'b', 'x', 'c'])).toEqual({ start: 2, endBefore: 2, endAfter: 3 })
    expect(changedRun(['a', 'b'], ['a', 'b'])).toEqual({ start: 2, endBefore: 2, endAfter: 2 })
    expect(changedRun(['a', 'b', 'c'], ['a', 'B', 'c'])).toEqual({ start: 1, endBefore: 2, endAfter: 2 })
  })
})

describe('a document with several layers', () => {
  const layers = ['notes', 'outline']
  const text = '<!-- section: One {#a1} -->\nFirst.\n\n::: notes\nA note.\n:::\n\n::: outline -\n- beat\n:::'

  it('shows each layer on its own, and the text without any of them', () => {
    const [one] = partition(text, layers)
    expect(one.id).toBe('a1')
    expect(project(one.text, 'output', layers).text).toBe('First.')
    expect(project(one.text, 'notes', layers).text).toBe('A note.')
    expect(project(one.text, 'outline', layers).text).toBe('- beat')
    for (const kind of ['output', 'notes', 'outline']) expect(sectionText(project(one.text, kind, layers))).toBe(one.text)
  })

  it('starts a block of the layer typed into', () => {
    const plain = '<!-- section: Two {#b2} -->\nSecond.'
    const outline = project(plain, 'outline', layers)
    expect(outline.empty).toBe(true)
    expect(sectionText(edit(outline, 0, 0, '- first'))).toBe('<!-- section: Two {#b2} -->\nSecond.\n\n::: outline\n- first\n:::')
  })

  it('leaves blocks of names that are not layers in the text', () => {
    const odd = '# A\nText.\n::: aside\nnot a layer\n:::'
    expect(project(odd, 'output', layers).text).toBe('# A\nText.\n::: aside\nnot a layer\n:::')
    // A one-file document knows notes alone.
    expect(project('# A\n::: outline\nx\n:::', 'output').text).toBe('# A\n::: outline\nx\n:::')
  })
})
