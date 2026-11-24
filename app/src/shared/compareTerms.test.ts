import { describe, expect, it } from 'vitest'

import { compareLayers, compareSentences, splitSentences } from './compareLayers'
import { suggestTerms, trackSavedWords, trackTerms } from './terms'

describe('splitSentences', () => {
  it('splits paragraphs and sentences, evening out whitespace', () => {
    expect(splitSentences('One here.  Two\nthere? "Three," she said.\n\nFour… Five')).toEqual(['One here.', 'Two there?', '"Three," she said.', 'Four…', 'Five'])
  })
})

describe('compareSentences', () => {
  it('keeps the shared sentences and marks the rest', () => {
    expect(compareSentences('A one. B two. C three.', 'A one. C three. D four.')).toEqual([
      { kind: 'same', text: 'A one.' },
      { kind: 'removed', text: 'B two.' },
      { kind: 'same', text: 'C three.' },
      { kind: 'added', text: 'D four.' },
    ])
  })
})

describe('compareLayers', () => {
  const text = [
    '## One', '', 'Kept here. Cut this one.', '', '::: old', 'Kept here. Older words.', ':::', '',
    '## Two', '', 'Brand new text.', '',
    '## Three', '', '::: old', 'Only in the old one.', ':::',
  ].join('\n')

  it('counts what was added, cut and kept per section, from the old layer to the text', () => {
    const result = compareLayers(text, ['old'], 'old', 'output')
    expect(result.sections.map(({ title, added, removed, kept }) => [title, added, removed, kept])).toEqual([
      ['One', 3, 2, 2], ['Two', 3, 0, 0], ['Three', 0, 5, 0],
    ])
    expect(result.newSections).toBe(1)
    expect(result.emptiedSections).toBe(1)
    expect(result.changedSections).toBe(3)
    expect(result.sections[0].similarity).toBe(44)
  })
})

describe('trackTerms', () => {
  const sections = [
    { title: 'A', line: 1, text: 'The universe begins. Universes abound.' },
    { title: 'B', line: 5, text: 'Here **universe** means all things. Reflexion too.' },
    { title: 'C', line: 9, text: 'Nothing here.' },
  ]

  it('counts uses per section, with plurals, and finds where a term is defined', () => {
    const [universe, reflexion] = trackTerms(sections, ['universe', 'Reflexion'])
    expect(universe).toMatchObject({ counts: [2, 1, 0], total: 3, sections: 2, first: 0, defined: 1, beforeDefinition: true })
    expect(reflexion).toMatchObject({ counts: [0, 1, 0], first: 1, defined: null, beforeDefinition: false })
  })
})

describe('suggestTerms', () => {
  it('suggests emphasized terms and recurring capitalized words', () => {
    const text = 'A **reflexion** is a loop. Another *reflexion* forms. The "reflexion" again. We met the Wheel, and the Wheel turned, so the Wheel spun.'
    expect(suggestTerms(text)).toEqual(['reflexion', 'Wheel'])
    expect(suggestTerms(text, ['Reflexion'])).toEqual(['Wheel'])
  })

  it('leaves out quoted speech', () => {
    const text = '"Does it get tired?" she asked. "To fix the set," he said. "To fix the set," again. Call it the "hum" and the "hum" stays.'
    expect(suggestTerms(text)).toEqual(['hum'])
  })
})

describe('trackSavedWords', () => {
  it('counts saved words with plurals, multi-word ones too, most used first, leaving out unused ones', () => {
    const sections = [
      { title: 'A', line: 1, text: 'Lamps and a lamp. The wireless man.' },
      { title: 'B', line: 5, text: 'Another lamp; the Wireless Man again.' },
    ]
    expect(trackSavedWords(sections, ['lamp', 'wireless man', 'beacon']).map((use) => [use.term, use.counts])).toEqual([
      ['lamp', [2, 1]], ['wireless man', [1, 1]],
    ])
  })
})
