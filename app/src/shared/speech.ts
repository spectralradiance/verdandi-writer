// What reading aloud says, in order: a section's Markdown split into sentence-sized
// pieces. Offsets are into the section's text as its editor holds it, so the piece
// being spoken can be highlighted there. The splitting follows Urdr Reader's
// (src/features/tts/segments.ts); Markdown's own marks are left unsaid.

export interface SpeechSegment {
  /** The section's row. */
  row: number
  /** [start, end) in the section's text. */
  start: number
  end: number
  /** What is said: the piece without its Markdown, whitespace evened out. */
  text: string
}

/** Long pieces are split further: some voices stop partway through long utterances. */
const MAX_CHARS = 280
/** Very short sentences ("Yes." "I.") are joined to the next so speech doesn't stutter. */
const MIN_CHARS = 24

const blank = (match: string) => match.replace(/[^\n]/g, ' ')

/**
 * The text with everything not to be said turned into spaces (line breaks kept), so it
 * is as long as the Markdown and offsets carry over: comments, images, link targets,
 * emphasis and code marks, heading, quote and list markers, and block fences.
 */
export function speakableText(markdown: string): string {
  return markdown
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/!\[\[[^\]\n]*\]\]/g, blank)
    .replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, blank)
    .replace(/^[ \t]*:::.*$/gm, blank)
    .replace(/\[\^[^\]\n]+\]/g, blank)
    // [[target|label]] says the label; [[target]] the target.
    .replace(/\[\[([^\]|\n]*)\|([^\]\n]*)\]\]/g, (_match, target: string, label: string) => `${blank(`[[${target}|`)}${label}  `)
    .replace(/\[\[([^\]\n]*)\]\]/g, (_match, target: string) => `  ${target}  `)
    // [text](url) says the text.
    .replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, (match, label: string) => ` ${label}${blank(match.slice(label.length + 1))}`)
    .replace(/^([ \t]*)(#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+\[[ xX]\][ \t]+|[-*+][ \t]+|\d+[.)][ \t]+)/gm, (_match, indent: string, marker: string) => indent + blank(marker))
    .replace(/\*+|`+|~~|(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, blank)
}

/** Sentence ranges [start, end) in `text`, sized for speech. */
export function sentenceRanges(text: string, lang?: string): [number, number][] {
  const flat = text.replace(/\s/g, ' ')
  const raw: [number, number][] = []
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const segmenter = new Intl.Segmenter(lang || undefined, { granularity: 'sentence' })
    for (const piece of segmenter.segment(flat)) raw.push([piece.index, piece.index + piece.segment.length])
  } else {
    const pattern = /[^.!?…]+[.!?…]+["'”’)\]]*\s*|[^.!?…]+$/g
    for (let match = pattern.exec(flat); match; match = pattern.exec(flat)) raw.push([match.index, match.index + match[0].length])
  }
  // Join short sentences forward (a short last one backward), then split long ones.
  const short = ([start, end]: [number, number]) => text.slice(start, end).trim().length < MIN_CHARS
  const joined: [number, number][] = []
  for (const range of raw) {
    const last = joined.at(-1)
    if (last && short(last)) last[1] = range[1]
    else joined.push([range[0], range[1]])
  }
  const tail = joined.at(-1)
  if (joined.length > 1 && tail && short(tail)) joined.splice(-2, 2, [joined.at(-2)![0], tail[1]])
  return joined.flatMap(([start, end]) => splitLong(text, start, end)).filter(([start, end]) => /\S/.test(text.slice(start, end)))
}

function splitLong(text: string, start: number, end: number): [number, number][] {
  const out: [number, number][] = []
  let from = start
  while (end - from > MAX_CHARS) {
    const window = text.slice(from, from + MAX_CHARS)
    const cut = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(': ')) + 2
    const at = cut > MAX_CHARS / 3 ? cut : window.lastIndexOf(' ') + 1 || MAX_CHARS
    out.push([from, from + at])
    from += at
  }
  out.push([from, end])
  return out
}

/**
 * A section's pieces, in order. Blocks (paragraphs, headings, list items, quotes) are
 * split apart first, so a heading or a list item without a full stop is a piece of its own.
 */
export function speechSegments(row: number, markdown: string, lang?: string): SpeechSegment[] {
  const text = speakableText(markdown)
  const segments: SpeechSegment[] = []
  const blockStart = /\n[ \t]*\n|\n(?=[ \t]*(?:#{1,6}\s|>|[-*+]\s|\d+[.)]\s|\||:::))/g
  let from = 0
  const addBlock = (start: number, end: number) => {
    for (const [a, b] of sentenceRanges(text.slice(start, end), lang)) {
      // Trimmed to what is said, so the highlight covers the words and not the marks around them.
      let s = start + a
      let e = start + b
      while (s < e && /\s/.test(text[s])) s += 1
      while (e > s && /\s/.test(text[e - 1])) e -= 1
      const said = text.slice(s, e).replace(/\s+/g, ' ').trim()
      if (/[\p{L}\p{N}]/u.test(said)) segments.push({ row, start: s, end: e, text: said })
    }
  }
  for (let match = blockStart.exec(markdown); match; match = blockStart.exec(markdown)) {
    addBlock(from, match.index)
    from = match.index + match[0].length
  }
  addBlock(from, text.length)
  return segments
}
