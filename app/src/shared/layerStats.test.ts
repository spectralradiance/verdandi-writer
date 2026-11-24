import { describe, expect, it } from 'vitest'

import { formatMinutes, layerOverview, layerStyleReport, layerTable } from './layerStats'

const TEXT = [
  'Opening.',
  '',
  '## One',
  '',
  'The first section has a few words in it.',
  '',
  'And a second paragraph.',
  '',
  '::: draft',
  'An older first section.',
  ':::',
  '',
  '## Two',
  '',
  'Short.',
  '',
  '## Three',
  '',
  '::: draft',
  'Only the draft has this one, and it runs on a little longer than the other.',
  ':::',
].join('\n')
const NAMES = ['draft']

describe('layerOverview', () => {
  it('counts the text layer per section', () => {
    const overview = layerOverview(TEXT, NAMES, 'output')
    expect(overview.rows.map((row) => [row.title, row.words])).toEqual([[null, 1], ['One', 14], ['Two', 2], ['Three', 1]])
    expect(overview.sections).toBe(3)
    expect(overview.filled).toBe(3)
    expect(overview.longest?.title).toBe('One')
    expect(overview.paragraphs).toBe(4)
  })

  it('counts another layer, and which sections have something in it', () => {
    const overview = layerOverview(TEXT, NAMES, 'draft')
    expect(overview.rows.map((row) => [row.title, row.words])).toEqual([['One', 4], ['Two', 0], ['Three', 16]])
    expect(overview.words).toBe(20)
    expect(overview.filled).toBe(2)
    expect(overview.longest?.title).toBe('Three')
  })
})

describe('layerTable', () => {
  it('puts every layer side by side', () => {
    expect(layerTable(TEXT, NAMES, ['output', 'draft'])[2]).toEqual({ title: 'Three', line: 17, words: { output: 1, draft: 16 } })
  })
})

describe('layerStyleReport', () => {
  it('measures the chosen layer, and leaves short sections unmeasured', () => {
    const report = layerStyleReport(TEXT, NAMES, 'draft')
    expect(report.sections.map((section) => [section.title, section.metrics.words, section.measured])).toEqual([['One', 4, false], ['Two', 0, false], ['Three', 16, false]])
    expect(report.document.metrics.words).toBe(20)
    expect(report.document.history).toEqual([])
  })
})

describe('formatMinutes', () => {
  it('rounds to minutes, then hours', () => {
    expect(formatMinutes(0.2)).toBe('1 min')
    expect(formatMinutes(42.4)).toBe('42 min')
    expect(formatMinutes(125)).toBe('2 h 5 min')
    expect(formatMinutes(120)).toBe('2 h')
  })
})
