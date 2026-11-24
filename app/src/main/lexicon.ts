import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

import type { LexiconEntry } from '../shared/ipc'
import { lexiconFileName, parseLexiconFile, serializeLexiconEntry } from '../shared/lexicon'

/** The personal lexicon: a folder of Markdown files, one per word. */
export class LexiconStore {
  private readonly directory: string

  constructor(directory: string) {
    this.directory = directory
  }

  get location(): string {
    return this.directory
  }

  async list(): Promise<LexiconEntry[]> {
    let names: string[]
    try {
      names = await readdir(this.directory)
    } catch {
      return []
    }
    const entries = await Promise.all(names.filter((name) => name.endsWith('.md')).map(async (name) =>
      parseLexiconFile(await readFile(path.join(this.directory, name), 'utf8').catch(() => ''))))
    return entries
      .filter((entry): entry is LexiconEntry => entry !== null)
      .sort((a, b) => a.word.localeCompare(b.word, undefined, { sensitivity: 'base' }))
  }

  /** Creates or replaces the entry for this word (atomic write). */
  async save(entry: LexiconEntry): Promise<LexiconEntry> {
    const word = entry.word.trim()
    if (!word) throw new Error('A lexicon entry needs a word.')
    const saved: LexiconEntry = {
      ...entry,
      word,
      tags: [...new Set(entry.tags.map((tag) => tag.trim()).filter(Boolean))],
      synonyms: [...new Set(entry.synonyms.map((synonym) => synonym.trim()).filter(Boolean))],
      added: entry.added || new Date().toISOString().slice(0, 10),
    }
    await mkdir(this.directory, { recursive: true })
    const target = path.join(this.directory, lexiconFileName(word))
    const temporary = `${target}.tmp`
    await writeFile(temporary, serializeLexiconEntry(saved), 'utf8')
    await rename(temporary, target)
    return saved
  }

  async remove(word: string, trash: (file: string) => Promise<void>): Promise<void> {
    await trash(path.join(this.directory, lexiconFileName(word)))
  }
}
