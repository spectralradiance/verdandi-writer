import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { StyleHistory, WHOLE_DOCUMENT } from './styleHistory'

const LONG = 'The tide went out and the boats lay down on their sides in the mud like tired dogs, and the gulls walked between them looking for anything the water had forgotten.'

describe('StyleHistory', () => {
  it('keeps one point a day for each section a save changed, by id', async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), 'verdandi-style-')), 'style-history.json')
    let today = new Date(2026, 10, 14)
    const history = new StyleHistory(file, () => today)
    const doc = (first: string) => `<!-- section: Ebb {#e1} -->\n${first}\n<!-- section: Flood {#f2} -->\n${LONG}\n<!-- section: Short {#s3} -->\nToo short.\n`
    history.recordSave('C:/docs/Tides', null, doc(LONG), ['notes'])
    history.recordSave('C:/docs/Tides', doc(LONG), doc(`${LONG} Then it came back.`), ['notes'])
    today = new Date(2026, 10, 15)
    history.recordSave('C:/docs/Tides', doc(`${LONG} Then it came back.`), doc(`${LONG} Then it came back, all at once, as if it had been called.`), ['notes'])

    // Read back from the file, as after a restart.
    const report = new StyleHistory(file, () => today).report('C:/docs/Tides', doc(LONG), ['notes'])
    const byKey = Object.fromEntries(report.sections.map((section) => [section.key, section]))
    expect(byKey.e1.history.map((point) => point.day)).toEqual(['2026-11-14', '2026-11-15'])
    expect(byKey.e1.history[1].values.words).toBeGreaterThan(byKey.e1.history[0].values.words!)
    expect(byKey.f2.history).toHaveLength(1)
    expect(byKey.s3.measured).toBe(false)
    expect(byKey.s3.history).toEqual([])
    expect(report.document.key).toBe(WHOLE_DOCUMENT)
    expect(report.document.history.map((point) => point.day)).toEqual(['2026-11-14', '2026-11-15'])
  })

  it('keys sections of a one-file document by title', async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), 'verdandi-style-')), 'style-history.json')
    const history = new StyleHistory(file)
    history.recordSave('C:/docs/a.md', null, `# One\n${LONG}\n\n::: notes\nnot counted\n:::\n`, null)
    const report = history.report('C:/docs/a.md', `# One\n${LONG}\n`, null)
    expect(report.sections[0]).toMatchObject({ key: 'title:One', title: 'One', line: 1, measured: true })
    expect(report.sections[0].history).toHaveLength(1)
  })
})
