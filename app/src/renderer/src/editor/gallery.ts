// A gallery layer's text is Markdown like any other, read as a list of images:
// Obsidian's embeds (`![[map.png]]`) and Markdown images (`![Map](map.png)`).
// Anything else in it (a caption line, a note) is kept, and shows in the text view.

export interface GalleryImage {
  /** Where the image is in the text. */
  from: number
  to: number
  /** `![[name]]`, or a Markdown image `![alt](target)`. */
  form: 'embed' | 'markdown'
  /** The file the image names: the embed's name, or the link's target. */
  target: string
  /** What it is called: the alt text, or the embed's label, or the file name without its extension. */
  label: string
}

const EMBED = /!\[\[([^\]|#]+\.(?:png|jpe?g|gif|webp|svg|avif|bmp))(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/gi
const MARKDOWN = /!\[([^\]]*)\]\((<[^>]*>|[^)\s]+)(?:\s+"[^"]*")?\)/g
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/

const fileLabel = (target: string) => (target.split(/[\\/]/).at(-1) ?? target).replace(/\.[^.]+$/, '')

/** The images in a gallery's text, in order. Code is skipped. */
export function galleryImages(text: string): GalleryImage[] {
  const images: GalleryImage[] = []
  let offset = 0
  let fence: string | null = null
  for (const line of text.split('\n')) {
    const opened = FENCE.exec(line)
    if (opened) {
      if (fence === null) fence = opened[1][0]
      else if (opened[1][0] === fence) fence = null
    } else if (fence === null) {
      const found: GalleryImage[] = []
      for (const match of line.matchAll(EMBED)) {
        const label = match[2]?.trim()
        found.push({
          from: offset + match.index, to: offset + match.index + match[0].length, form: 'embed', target: match[1].trim(),
          label: label && !/^\d+(?:x\d+)?$/.test(label) ? label : fileLabel(match[1].trim()),
        })
      }
      for (const match of line.matchAll(MARKDOWN)) {
        const target = match[2].replace(/^<(.*)>$/, '$1')
        found.push({ from: offset + match.index, to: offset + match.index + match[0].length, form: 'markdown', target, label: match[1].trim() || fileLabel(target) })
      }
      images.push(...found.sort((a, b) => a.from - b.from))
    }
    offset += line.length + 1
  }
  return images
}

/** The text with embeds for `names` added at its end, one per line. */
export function addToGallery(text: string, names: readonly string[]): string {
  if (names.length === 0) return text
  const embeds = names.map((name) => `![[${name}]]`).join('\n')
  const body = text.replace(/\s+$/, '')
  return body ? `${body}\n${embeds}` : embeds
}

/** The text without one image; its line goes too when nothing else is on it. */
export function removeFromGallery(text: string, image: Pick<GalleryImage, 'from' | 'to'>): string {
  const lineStart = text.lastIndexOf('\n', image.from - 1) + 1
  const lineEndAt = text.indexOf('\n', image.to)
  const lineEnd = lineEndAt === -1 ? text.length : lineEndAt
  const rest = text.slice(lineStart, image.from) + text.slice(image.to, lineEnd)
  if (rest.trim()) return text.slice(0, image.from) + text.slice(image.to)
  // The whole line goes, with one of the line breaks around it.
  if (lineEndAt !== -1) return text.slice(0, lineStart) + text.slice(lineEnd + 1)
  return text.slice(0, Math.max(0, lineStart - 1))
}

/** Moves an image to just before another one (or to the end, with `before` null), as its own line. */
export function moveInGallery(text: string, image: GalleryImage, before: GalleryImage | null): string {
  if (before && before.from === image.from) return text
  const source = text.slice(image.from, image.to)
  const without = removeFromGallery(text, image)
  if (!before) return addToGalleryText(without, source)
  // Where `before` is once `image` is gone.
  const shift = before.from > image.from ? text.length - without.length : 0
  const at = before.from - shift
  const lineStart = without.lastIndexOf('\n', at - 1) + 1
  return `${without.slice(0, lineStart)}${source}\n${without.slice(lineStart)}`
}

function addToGalleryText(text: string, line: string): string {
  const body = text.replace(/\s+$/, '')
  return body ? `${body}\n${line}` : line
}
