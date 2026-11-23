// The sample workspace (samples/, opened by scripts/dev.ps1 -Samples) loads as intended:
// its document folders open whole, with their layers, fields and saved views.

import { cp, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { splitSections } from '../shared/document'
import { undeclaredCallouts } from '../shared/layers'
import { isFolderDocument, readLayerDocument, readViews } from './layerDocument'

const SAMPLES = path.resolve(__dirname, '../../../samples')

async function copy(): Promise<string> {
  const target = path.join(await mkdtemp(path.join(tmpdir(), 'verdandi-samples-')), 'samples')
  await cp(SAMPLES, target, { recursive: true })
  return target
}

describe('the sample workspace', () => {
  it('opens Salt and Signal whole, with its layers, fields and views', async () => {
    const folder = path.join(await copy(), 'Salt and Signal')
    expect(await isFolderDocument(folder)).toBe(true)
    const document = await readLayerDocument(folder)
    const layers = document.layers!.map((layer) => layer.name)
    expect(layers).toEqual(['notes', 'outline', 'research', 'images'])
    const sections = splitSections(document.text, layers)
    expect(sections).toHaveLength(12)
    expect(sections.at(-1)?.title).toBe('Coda: Harlow Point')
    expect(sections[0].layers.outline).toContain('The letter')
    expect(sections[0].layers.images).toContain('![[skerrow-map.svg')
    expect(Object.values(document.fields!).filter((fields) => fields.status === 'idea')).toHaveLength(5)
    expect(undeclaredCallouts(document.text, layers)).toEqual([])
    expect((await readViews(folder)).map((view) => view.name)).toEqual(['Outline', 'Drafting act one', 'Still ideas'])
  })

  it('opens Tidelines as poems with notes', async () => {
    const document = await readLayerDocument(path.join(await copy(), 'Tidelines'))
    const sections = splitSections(document.text, ['notes'])
    expect(sections.map((section) => section.title)).toEqual(['Low Water', 'Keeper', 'Call Sign', 'Spring Tide'])
    expect(sections[1].notes).toContain('volta')
  })
})
