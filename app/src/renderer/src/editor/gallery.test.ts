import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { localFileUrl } from '../../../shared/paths'
import { addToGallery, galleryImages, moveInGallery, removeFromGallery } from './gallery'
import { buildLiveDecorations, documentPath, imageFolder, wikiImageSources } from './livePreview'

const GALLERY = ['![[map.png]]', 'The coast, early.', '![[shore.jpg|The shore]] ![Gulls](birds/gulls.webp)', '```', '![[code.png]]', '```', '![[sketch.png|300]]'].join('\n')

describe('galleryImages', () => {
  it('reads embeds and Markdown images in order, with their labels, skipping code', () => {
    expect(galleryImages(GALLERY).map(({ form, target, label }) => `${form}:${target}:${label}`)).toEqual([
      'embed:map.png:map',
      'embed:shore.jpg:The shore',
      'markdown:birds/gulls.webp:Gulls',
      'embed:sketch.png:sketch',
    ])
  })

  it('gives each image’s place in the text', () => {
    const [first, second] = galleryImages(GALLERY)
    expect(GALLERY.slice(first.from, first.to)).toBe('![[map.png]]')
    expect(GALLERY.slice(second.from, second.to)).toBe('![[shore.jpg|The shore]]')
  })
})

describe('changing a gallery', () => {
  it('adds embeds at the end, one per line', () => {
    expect(addToGallery('', ['a.png'])).toBe('![[a.png]]')
    expect(addToGallery('![[a.png]]\n\n', ['b.png', 'c 2.png'])).toBe('![[a.png]]\n![[b.png]]\n![[c 2.png]]')
  })

  it('removes an image, and its line when nothing else is on it', () => {
    const images = galleryImages(GALLERY)
    expect(removeFromGallery(GALLERY, images[0])).toBe(GALLERY.replace('![[map.png]]\n', ''))
    expect(removeFromGallery(GALLERY, images[1])).toBe(GALLERY.replace('![[shore.jpg|The shore]]', ''))
    expect(removeFromGallery(GALLERY, images[3])).toBe(GALLERY.replace('\n![[sketch.png|300]]', ''))
  })

  it('moves an image before another, or to the end', () => {
    const text = '![[a.png]]\n![[b.png]]\n![[c.png]]'
    const [a, b, c] = galleryImages(text)
    expect(moveInGallery(text, c, a)).toBe('![[c.png]]\n![[a.png]]\n![[b.png]]')
    expect(moveInGallery(text, a, c)).toBe('![[b.png]]\n![[a.png]]\n![[c.png]]')
    expect(moveInGallery(text, a, null)).toBe('![[b.png]]\n![[c.png]]\n![[a.png]]')
    expect(moveInGallery(text, b, b)).toBe(text)
  })
})

describe('image embeds in the live preview', () => {
  const folder = 'C:\\vault\\Eras'

  it('looks in attachments first, then the folder', () => {
    expect(wikiImageSources('map.png', folder)).toEqual([
      localFileUrl('C:\\vault\\Eras\\attachments\\map.png'), localFileUrl('C:\\vault\\Eras\\map.png'),
    ])
    expect(wikiImageSources('art/map.png', folder)).toEqual([localFileUrl('C:\\vault\\Eras\\art\\map.png')])
    expect(wikiImageSources('file:///C:/x.png', folder)).toEqual([])
  })

  it('shows an embed as an image, outside code and away from the cursor', () => {
    const doc = 'A map: ![[map.png|The map]]\n\n`![[inline.png]]`\n\n![[note]]'
    const state = EditorState.create({
      doc, extensions: [markdown({ base: markdownLanguage }), documentPath.of(folder), imageFolder.of(folder)],
    })
    ensureSyntaxTree(state, doc.length, 5000)
    const widgets: { text: string; src: string; alt: string; fallbacks: readonly string[] }[] = []
    buildLiveDecorations(state, []).between(0, doc.length, (from, to, value) => {
      const widget = (value.spec as { widget?: { src: string; alt: string; fallbacks: readonly string[] } }).widget
      if (widget && 'fallbacks' in widget) widgets.push({ text: doc.slice(from, to), src: widget.src, alt: widget.alt, fallbacks: widget.fallbacks })
    })
    expect(widgets).toEqual([{
      text: '![[map.png|The map]]', src: localFileUrl('C:\\vault\\Eras\\attachments\\map.png'), alt: 'The map',
      fallbacks: [localFileUrl('C:\\vault\\Eras\\map.png')],
    }])
    const atCursor = buildLiveDecorations(state, [{ from: 10, to: 10 }])
    let replaced = false
    atCursor.between(0, 30, (_from, _to, value) => {
      if ((value.spec as { widget?: unknown }).widget) replaced = true
    })
    expect(replaced).toBe(false)
  })
})
