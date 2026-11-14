import { randomBytes } from 'node:crypto'
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { convertOneFile, newSectionId } from '../shared/layers'
import { readTextDocument } from './fileService'
import { encodeText } from './textFile'

/** Where a converted document keeps the one-file original, inside its folder. */
export const ORIGINAL_DIR = path.join('.verdandi', 'original')

export interface ConvertedFolder {
  /** The new document folder. */
  folder: string
  /** The document note inside it, named after the folder. */
  note: string
  /** Where the original file now is. */
  original: string
}

const exists = (target: string) => stat(target).then(() => true, () => false)

/**
 * Turns a one-file document into a document folder next to it (PLAN.md §3b): a
 * document note, one file per section, and the original file kept in
 * `.verdandi/original/` so the conversion can be undone. Everything is written to
 * a hidden folder first and renamed into place last, so a failure leaves the
 * original where it was.
 */
export async function convertFileToFolder(file: string, newId: () => string = newSectionId): Promise<ConvertedFolder> {
  const source = await readTextDocument(file)
  const parent = path.dirname(file)
  const fileName = path.basename(file)
  const base = path.basename(file, path.extname(file)) || fileName
  // An extensionless file has its folder's name: that name is free once the file moves.
  let name = base
  for (let count = 2; ; count += 1) {
    const candidate = path.join(parent, name)
    if (candidate === file || !(await exists(candidate))) break
    name = `${base} ${count}`
  }

  const converted = convertOneFile(source.text, name, newId)
  const format = { encoding: 'utf-8', eol: source.format.eol, mixedEol: false } as const
  const write = (target: string, text: string) => writeFile(target, encodeText(text, format).bytes, { flag: 'wx' })

  const staging = path.join(parent, `.${name}.verdandi-${randomBytes(4).toString('hex')}`)
  await mkdir(path.join(staging, ORIGINAL_DIR), { recursive: true })
  try {
    await write(path.join(staging, `${name}.md`), converted.note)
    for (const section of converted.sections) await write(path.join(staging, `${section.name}.md`), section.text)
    await rename(file, path.join(staging, ORIGINAL_DIR, fileName))
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
  const folder = path.join(parent, name)
  try {
    await rename(staging, folder)
  } catch (error) {
    await rename(path.join(staging, ORIGINAL_DIR, fileName), file).catch(() => {})
    await rm(staging, { recursive: true, force: true })
    throw error
  }
  return { folder, note: path.join(folder, `${name}.md`), original: path.join(folder, ORIGINAL_DIR, fileName) }
}

/**
 * Undoes a conversion: puts the original file back next to the folder and moves
 * the folder, with any edits made since, to the trash. Returns the file's path.
 */
export async function undoConversion(folder: string, trash: (target: string) => Promise<void>): Promise<string> {
  const originals = await readdir(path.join(folder, ORIGINAL_DIR)).catch(() => [] as string[])
  if (originals.length !== 1) throw new Error('This folder was not converted from a single file, so there is nothing to undo.')
  const file = path.join(path.dirname(folder), originals[0])
  if (file !== folder && (await exists(file))) throw new Error(`${originals[0]} already exists next to the folder.`)
  if (file !== folder) {
    await rename(path.join(folder, ORIGINAL_DIR, originals[0]), file)
    await trash(folder)
    return file
  }
  // An extensionless original has the folder's own name, so the folder moves aside first.
  const parked = path.join(path.dirname(folder), `.${path.basename(folder)}.verdandi-undo-${randomBytes(4).toString('hex')}`)
  await rename(folder, parked)
  await rename(path.join(parked, ORIGINAL_DIR, originals[0]), file)
  await trash(parked)
  return file
}
