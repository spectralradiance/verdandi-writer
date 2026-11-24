import { describe, expect, it } from 'vitest'

import { speakableText, speechSegments } from './speech'

describe('speakableText', () => {
  it('blanks Markdown marks but keeps the length', () => {
    const markdown = '## A *bold* [link](http://x.y) and ![[pic.png]] <!-- no -->'
    const text = speakableText(markdown)
    expect(text).toHaveLength(markdown.length)
    expect(text.replace(/\s+/g, ' ').trim()).toBe('A bold link and')
  })
})

describe('speechSegments', () => {
  it('splits blocks and sentences, with offsets into the Markdown', () => {
    const markdown = '# The Heading\n\nThe lamp was lit every night for years. Maren trimmed its **wick** with care.\n- a list item without a stop\n- another item in the list here'
    const segments = speechSegments(7, markdown)
    expect(segments.map((segment) => segment.text)).toEqual([
      'The Heading',
      'The lamp was lit every night for years.',
      'Maren trimmed its wick with care.',
      'a list item without a stop',
      'another item in the list here',
    ])
    const wick = segments[2]
    expect(markdown.slice(wick.start, wick.end)).toBe('Maren trimmed its **wick** with care.')
    expect(wick.row).toBe(7)
  })
})
