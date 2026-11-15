import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { analyzeStyle, type StylePoint, trackedValues } from '../shared/analysis'
import { splitSections } from '../shared/document'
import type { SectionStyle, StyleReport } from '../shared/ipc'
import type { LayerNames } from '../shared/notes'
import { parseMarker } from '../shared/text'
import { localDay } from './stats'

/** The key the whole document's history is kept under, next to its sections'. */
export const WHOLE_DOCUMENT = '*'
/** Sections shorter than this aren't measured: the numbers would mean little. */
export const MIN_WORDS = 20
const MAX_POINTS = 400

interface Track {
  title: string
  points: StylePoint[]
}

interface HistoryFile {
  /** By document (lower-cased path on Windows), then by section: its id in a document folder, else its title. */
  documents: Record<string, Record<string, Track>>
}

interface Measured {
  key: string
  title: string
  line: number
  text: string
}

/** A document's sections as the history knows them, plus the whole text. */
function measured(text: string, layers: LayerNames): Measured[] {
  const lines = text.split('\n')
  const sections = splitSections(text, layers).filter((section) => section.title !== null)
  const result: Measured[] = sections.map((section) => ({
    key: (section.named ? parseMarker(lines[section.line - 1])?.id : undefined) ?? `title:${section.title}`,
    title: section.title!,
    line: section.line,
    text: section.output,
  }))
  result.push({ key: WHOLE_DOCUMENT, title: 'Whole document', line: 1, text: sections.map((section) => section.output).join('\n\n') })
  return result
}

/**
 * Vocabulary and grammar measures per section, one point per day, in
 * <userData>/style-history.json. A section is measured when a save changes its text,
 * so its history shows how revising it changed it.
 */
export class StyleHistory {
  private readonly file: string
  private readonly now: () => Date
  private data: HistoryFile

  constructor(file: string, now: () => Date = () => new Date()) {
    this.file = file
    this.now = now
    this.data = this.load()
  }

  /** Records today's measures of each section whose text a save changed. */
  recordSave(file: string, before: string | null, after: string, layers: LayerNames): void {
    const was = new Map(before === null ? [] : measured(before, layers).map((section) => [section.key, section.text]))
    const day = localDay(this.now())
    const tracks = (this.data.documents[key(file)] ??= {})
    let changed = false
    for (const section of measured(after, layers)) {
      if (was.get(section.key) === section.text && tracks[section.key]) continue
      const metrics = analyzeStyle(section.text)
      if (metrics.words < MIN_WORDS) continue
      const track = (tracks[section.key] ??= { title: section.title, points: [] })
      track.title = section.title
      const point = { day, values: trackedValues(metrics) }
      if (track.points.at(-1)?.day === day) track.points[track.points.length - 1] = point
      else track.points.push(point)
      if (track.points.length > MAX_POINTS) track.points.splice(0, track.points.length - MAX_POINTS)
      changed = true
    }
    if (changed) this.save()
  }

  /** Each section's measures now and its history, for a document's current text. */
  report(file: string, text: string, layers: LayerNames): StyleReport {
    const tracks = this.data.documents[key(file)] ?? {}
    const sections: SectionStyle[] = measured(text, layers).map((section) => {
      const metrics = analyzeStyle(section.text)
      return {
        key: section.key,
        title: section.title,
        line: section.line,
        measured: metrics.words >= MIN_WORDS,
        metrics,
        history: tracks[section.key]?.points ?? [],
      }
    })
    const whole = sections.pop()!
    return { sections, document: whole }
  }

  private load(): HistoryFile {
    if (!existsSync(this.file)) return { documents: {} }
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<HistoryFile>
      return { documents: raw.documents && typeof raw.documents === 'object' ? raw.documents : {} }
    } catch {
      return { documents: {} }
    }
  }

  private save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true })
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.data), 'utf8')
    renameSync(`${this.file}.tmp`, this.file)
  }
}

function key(file: string): string {
  const resolved = path.resolve(file)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}
