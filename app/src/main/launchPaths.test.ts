import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { launchCandidates, planLaunch } from './launchPaths'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'verdandi-launch-'))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

const isDocument = async (folder: string) => folder.endsWith('Doc')

describe('launchCandidates', () => {
  it('takes absolute paths, skipping flags, the executable and the app folder', () => {
    const exe = path.join(dir, 'Verdandi.exe')
    const app = path.join(dir, 'app')
    const doc = path.join(dir, 'Doc')
    expect(launchCandidates([exe, '--inspect', app, 'relative', doc], undefined, [exe, app])).toEqual([doc])
    expect(launchCandidates([], `${doc}${path.delimiter}${app}`, [app])).toEqual([doc])
  })
})

describe('planLaunch', () => {
  it('adds folders, and opens the first that is a document', async () => {
    const shelf = path.join(dir, 'Shelf')
    const doc = path.join(dir, 'Doc')
    const other = path.join(dir, 'Other Doc')
    await Promise.all([mkdir(shelf), mkdir(doc), mkdir(other)])
    const plan = await planLaunch([shelf], [shelf, doc, other, path.join(dir, 'missing')], isDocument)
    expect(plan).toEqual({ roots: [shelf, doc, other], open: doc })
  })

  it('opens a main file as its document folder, and a file inside a workspace folder without adding one', async () => {
    const doc = path.join(dir, 'Doc')
    await mkdir(doc)
    await writeFile(path.join(doc, 'Doc.md'), '---\nverdandi: document\n---\n')
    await writeFile(path.join(dir, 'note.md'), 'A note.')
    expect(await planLaunch([], [path.join(doc, 'Doc.md')], isDocument)).toEqual({ roots: [doc], open: doc })
    expect(await planLaunch([dir], [path.join(dir, 'note.md')], isDocument)).toEqual({ roots: [dir], open: path.join(dir, 'note.md') })
  })
})
