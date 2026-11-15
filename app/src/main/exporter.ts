import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { marked } from 'marked'

import { demoteHeadings, splitSections } from '../shared/document'
import type { ExportOptions } from '../shared/ipc'
import { finishedText, layerLabel } from '../shared/layers'
import type { LayerNames } from '../shared/notes'
import { DEFAULT_PREFERENCES, type ExportPreferences } from '../shared/preferences'

export interface ExportedMarkdown {
  markdown: string
  /** Sections exported, and those left out because they had nothing to export. */
  sections: number
  skipped: string[]
}

const IMAGE = /\.(?:png|jpe?g|gif|webp|svg|avif|bmp)$/i

/**
 * Obsidian's links as plain Markdown, which HTML, PDF and other Markdown readers
 * understand: an image embed `![[map.png|Map]]` becomes an image (found by
 * `resolveImage`, relative to the export's base folder), and a link `[[Page|shown]]`
 * becomes its text. Code is left alone.
 */
export function plainLinks(markdown: string, resolveImage: (name: string) => string = (name) => name): string {
  let fence: string | null = null
  return markdown.split('\n').map((line) => {
    const opened = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line)
    if (opened) {
      if (fence === null) fence = opened[1][0]
      else if (opened[1][0] === fence) fence = null
      return line
    }
    if (fence !== null) return line
    return line.split(/(`[^`]*`)/).map((part, index) => (index % 2 === 1 ? part : part
      .replace(/!\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (whole, target: string, alt?: string) => {
        const name = target.trim()
        if (!IMAGE.test(name)) return whole
        const size = alt !== undefined && /^\d+(?:x\d+)?$/.test(alt.trim())
        const shown = alt !== undefined && !size ? alt.trim() : name.replace(/\.[^.]+$/, '')
        return `![${shown}](<${resolveImage(name)}>)`
      })
      .replace(/(?<!!)\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_whole, target: string, shown?: string) => (shown ?? target.replace(/#.*$/, '')).trim()))).join('')
  }).join('\n')
}

/**
 * A document as Markdown for export. The output is the text without its layer
 * blocks. A layer export gives each section's layer under the section's heading; the
 * notes export gives all of a section's layers, each under its own subheading when
 * there is more than one. With a title, the title is the only top-level heading and
 * the rest move down one.
 */
export function exportMarkdown(text: string, title: string, options: Pick<ExportOptions, 'content' | 'includeTitle'>, layers?: LayerNames): ExportedMarkdown {
  const level = options.includeTitle ? 2 : 1
  const parts: string[] = options.includeTitle ? [`# ${title}`] : []
  const sections = splitSections(text, layers)
  if (options.content === 'output') {
    const output = finishedText(text, layers).trim()
    if (output) parts.push(options.includeTitle ? demoteHeadings(output, 2) : output)
    return { markdown: `${parts.join('\n\n')}\n`, sections: sections.filter((section) => section.output).length, skipped: [] }
  }
  const only = options.content.startsWith('layer:') ? options.content.slice('layer:'.length) : null
  const order = layers ? [...layers] : ['notes']
  const skipped: string[] = []
  let count = 0
  for (const section of sections) {
    const name = section.title ?? 'Document notes'
    const present = (only ? [only] : order).filter((layer) => section.layers[layer]?.trim())
    if (present.length === 0) {
      if (section.title !== null) skipped.push(name)
      continue
    }
    count += 1
    parts.push(`${'#'.repeat(level)} ${name}`)
    if (present.length === 1) parts.push(demoteHeadings(section.layers[present[0]], level + 1))
    else for (const layer of present) parts.push(`${'#'.repeat(level + 1)} ${layerLabel(layer)}`, demoteHeadings(section.layers[layer], level + 2))
  }
  return { markdown: `${parts.join('\n\n')}\n`, sections: count, skipped }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!)
}

/** A self-contained HTML page; relative images resolve against the document folder. */
export function renderHtml(markdown: string, title: string, baseFolder: string, style: ExportPreferences = DEFAULT_PREFERENCES.export): string {
  const body = marked.parse(markdown, { async: false, gfm: true })
  const base = pathToFileURL(baseFolder.endsWith(path.sep) ? baseFolder : baseFolder + path.sep).href
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<base href="${escapeHtml(base)}">
<style>
  body { max-width: 42rem; margin: 3rem auto; padding: 0 1.5rem; font-family: ${style.font}; font-size: ${style.fontSize}pt; line-height: ${style.lineHeight}; color: #1f2421; }
  h1, h2, h3, h4 { line-height: 1.3; font-weight: 600; }
  h1 { font-size: 2em; margin-bottom: 1.2em; }
  h2 { font-size: 1.4em; margin-top: 2em; }
  blockquote { margin-left: 0; padding-left: 1em; border-left: 3px solid #b9c9bf; color: #555; font-style: italic; }
  code { font-family: Consolas, monospace; font-size: 0.88em; background: #efede6; padding: 0.1em 0.3em; border-radius: 3px; }
  pre { background: #efede6; padding: 0.8em 1em; border-radius: 5px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  img { max-width: 100%; }
  table { border-collapse: collapse; }
  th, td { border: 1px solid #d9d6cc; padding: 0.3em 0.7em; }
  hr { border: none; border-top: 1px solid #d9d6cc; margin: 2em 0; }
  @media print { body { max-width: none; margin: 0; padding: 0; } h2 { break-after: avoid; } }
</style>
</head>
<body>
${body}
</body>
</html>
`
}

export async function writeExport(
  target: string,
  format: ExportOptions['format'],
  markdown: string,
  title: string,
  folder: string,
  printToPdf: (html: string) => Promise<Buffer>,
  style: ExportPreferences = DEFAULT_PREFERENCES.export,
): Promise<void> {
  if (format === 'md') await writeFile(target, markdown, 'utf8')
  else if (format === 'html') await writeFile(target, renderHtml(markdown, title, folder, style), 'utf8')
  else await writeFile(target, await printToPdf(renderHtml(markdown, title, folder, style)))
}
