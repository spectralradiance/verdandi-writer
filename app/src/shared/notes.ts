// Layer blocks inside a text: a Pandoc-style fenced div that opens with `::: notes`
// (or another layer's name) and closes with `:::`. Everything else is the output
// (the text itself). A one-file document has one layer, its notes; a folder
// document declares its own (see layers.ts), and its working text holds each as
// such a block.

export type LineRole = 'output' | 'notes' | 'open' | 'close'

/** The layer names a text's blocks may use, or null for a one-file document's notes alone. */
export type LayerNames = readonly string[] | null | undefined

const OPEN = /^[ \t]{0,3}:{3,}[ \t]*notes[ \t]*$/i
/** `::: name`, with an optional fold sign and title after a space: `::: notes - Title`. */
const LAYER_OPEN = /^[ \t]{0,3}:{3,}[ \t]*([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)(?:[ \t](.*))?$/
const CLOSE = /^[ \t]{0,3}:{3,}[ \t]*$/
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/

/** Labels of layers whose names as written aren't layer names (`draft 11-21`), by layer name. */
const labels = new Map<string, string>()

/** Shows these layers by their names as written (the open document's, in the window). */
export function setLayerLabels(layers: readonly { name: string; label?: string }[]): void {
  for (const layer of layers) if (layer.label) labels.set(layer.name, layer.label)
}

/** A layer's name as a label: `story-beats` → `Story beats`; `output` is the section's text. */
export function layerLabel(name: string): string {
  if (name === 'output') return 'Text'
  const label = labels.get(name)
  if (label) return label.charAt(0).toUpperCase() + label.slice(1)
  const words = name.replace(/-/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export const NOTES_OPEN_LINE = '::: notes'
export const NOTES_CLOSE_LINE = ':::'

export interface BlockLine {
  /** `notes` is any layer's contents, `open` and `close` its block's markers. */
  role: LineRole
  /** The layer of a block line, lowercase, or null for output. */
  layer: string | null
}

/**
 * Classifies each line as output, or a layer block's marker or contents. Without a
 * list of layers only `::: notes` opens a block. A block that is never closed runs
 * to the end of the text, so notes being typed still look like notes. Fenced code
 * blocks are respected: a `::: notes` line inside one is code, and a `:::` inside
 * code within a block does not end it.
 */
export function classifyBlocks(lines: readonly string[], layers?: LayerNames): BlockLine[] {
  const names = layers ? new Set(layers.map((name) => name.toLowerCase())) : null
  const opens = (line: string): string | null => {
    if (!names) return OPEN.test(line) ? 'notes' : null
    const match = LAYER_OPEN.exec(line)
    return match && names.has(match[1].toLowerCase()) ? match[1].toLowerCase() : null
  }
  const roles: BlockLine[] = []
  let layer: string | null = null
  let fence: string | null = null
  const inside = (): BlockLine => ({ role: layer === null ? 'output' : 'notes', layer })
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '')
    const fenceMatch = FENCE.exec(line)
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1][0]
      else if (fenceMatch[1][0] === fence) fence = null
      roles.push(inside())
      continue
    }
    if (fence !== null) {
      roles.push(inside())
      continue
    }
    const opened: string | null = layer === null ? opens(line) : null
    if (opened !== null) {
      layer = opened
      roles.push({ role: 'open', layer })
    } else if (layer !== null && CLOSE.test(line)) {
      roles.push({ role: 'close', layer })
      layer = null
    } else {
      roles.push(inside())
    }
  }
  return roles
}

/** Each line's role, without saying which layer a block is. */
export function classifyLines(lines: readonly string[], layers?: LayerNames): LineRole[] {
  return classifyBlocks(lines, layers).map((line) => line.role)
}

/** The `::: name` line that opens a block of a layer. */
export function blockOpenLine(layer: string): string {
  return `::: ${layer}`
}

/** The text without its layer blocks, and without the blank lines they leave behind. */
export function stripNotes(text: string, layers?: LayerNames): string {
  if (!/^[ \t]{0,3}:{3,}/m.test(text)) return text
  const lines = text.split('\n')
  const roles = classifyLines(lines, layers)
  const kept: string[] = []
  lines.forEach((line, index) => {
    if (roles[index] === 'output') {
      kept.push(line)
    } else if (roles[index] === 'close' && kept.length > 0 && kept.at(-1)!.trim() === '') {
      kept.pop() // the blank line that separated the block from the text before it
    }
  })
  return kept.join('\n').replace(/\n{3,}/g, '\n\n')
}
