import { describe, expect, it } from 'vitest'

import { moveSectionText } from './document'

const doc = '# A\none\n\n# B\ntwo\n\n# C\nthree\n'

describe('moveSectionText', () => {
  it('moves a section down and up, keeping the text intact', () => {
    expect(moveSectionText(doc, 0, 2)).toBe('# B\ntwo\n\n# C\nthree\n\n# A\none\n')
    expect(moveSectionText(doc, 2, 0)).toBe('# C\nthree\n\n# A\none\n\n# B\ntwo\n')
    expect(moveSectionText(doc, 1, 0)).toBe('# B\ntwo\n\n# A\none\n\n# C\nthree\n')
  })

  it('leaves text before the first heading in place', () => {
    expect(moveSectionText('intro\n\n# A\na\n\n# B\nb', 0, 1)).toBe('intro\n\n# B\nb\n\n# A\na')
  })

  it('carries sub-headings and notes with their section', () => {
    const text = '# A\n## sub\nx\n::: notes\nn\n:::\n\n# B\ny\n'
    expect(moveSectionText(text, 0, 1)).toBe('# B\ny\n\n# A\n## sub\nx\n::: notes\nn\n:::\n')
  })

  it('does not run a section into the next heading when it had no blank line after it', () => {
    expect(moveSectionText('# A\na\n# B\nb', 1, 0)).toBe('# B\nb\n\n# A\na')
  })

  it('does nothing for the same place or an unknown section', () => {
    expect(moveSectionText(doc, 1, 1)).toBeNull()
    expect(moveSectionText(doc, 0, 5)).toBeNull()
  })

  it('is reversible', () => {
    const moved = moveSectionText(doc, 0, 2) ?? ''
    expect(moveSectionText(moved, 2, 0)).toBe(doc)
  })
})
