import { ImagePlus, Pencil, X } from 'lucide-react'
import { type DragEvent, type ReactNode, useCallback, useRef, useState } from 'react'

import { addToGallery, type GalleryImage, galleryImages, moveInGallery, removeFromGallery } from './gallery'
import { imageSource, wikiImageSources } from './livePreview'
import type { MarkdownEditorHandle } from './MarkdownEditor'

interface GalleryCellProps {
  /** The document folder, where `attachments/` is. */
  folder: string
  readOnly: boolean
  initialText: string
  /** Hands the layer's editor to the grid that owns it. */
  register: (handle: MarkdownEditorHandle | null) => void
  /**
   * Renders the layer's Markdown editor, which stays mounted (hidden) while the grid
   * shows: `ref` takes its handle, and `onText` hears every edit typed in it.
   */
  editor: (ref: (handle: MarkdownEditorHandle | null) => void, onText: (text: string) => void) => ReactNode
  /** The grid's own label, for screen readers: "Images of The First Era". */
  label: string
}

/** Where to look for an image, in order. */
function sourcesOf(image: GalleryImage, folder: string): string[] {
  if (image.form === 'embed') return wikiImageSources(image.target, folder)
  const source = imageSource(image.target, folder)
  return source ? [source] : []
}

function Thumbnail({ image, folder }: { image: GalleryImage; folder: string }) {
  const sources = sourcesOf(image, folder)
  const [attempt, setAttempt] = useState(0)
  if (attempt >= sources.length) return <span className="gallery-missing">Not found: {image.target}</span>
  return <img src={sources[attempt]} alt={image.label} draggable={false} onError={() => setAttempt((count) => count + 1)} />
}

const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes('Files')

/**
 * A gallery layer: its images as a grid. Images are added from a file dialog or
 * by dropping them on the grid (they are copied into the document's
 * `attachments/`), dragged to reorder, and removed from the layer (the file
 * stays). "Edit as text" shows the layer's Markdown.
 */
export function GalleryCell({ folder, readOnly, initialText, register, editor, label }: GalleryCellProps) {
  const [text, setText] = useState(initialText)
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dropping, setDropping] = useState(false)
  const [handle, setHandle] = useState<MarkdownEditorHandle | null>(null)
  const dragged = useRef<number | null>(null)

  // The grid follows the editor: edits typed in it (onText), and text the grid sets from outside.
  const attach = useCallback((editorHandle: MarkdownEditorHandle | null) => {
    setHandle(editorHandle)
    register(editorHandle && {
      ...editorHandle,
      sync: (next: string) => {
        editorHandle.sync(next)
        setText(next)
      },
      replaceAll: (next: string) => {
        editorHandle.replaceAll(next)
        setText(next)
      },
    })
  }, [register])
  const images = galleryImages(text)

  const change = (next: string) => {
    if (!handle || next === handle.getText()) return
    handle.replaceAll(next)
    setText(next)
  }

  const add = async (files?: string[]) => {
    setError(null)
    try {
      const names = await window.verdandi.documents.addImages(folder, files)
      if (names.length) change(addToGallery(handle?.getText() ?? text, names))
      else if (files?.length) setError('Only image files can be added.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  return (
    <div
      className={`gallery-cell${dropping ? ' dropping' : ''}`}
      onDragOver={(event) => {
        if (readOnly || !hasFiles(event)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        setDropping(true)
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(event) => {
        setDropping(false)
        if (readOnly || !hasFiles(event)) return
        event.preventDefault()
        const paths = [...event.dataTransfer.files].map((file) => window.verdandi.files.pathOf(file)).filter(Boolean)
        if (paths.length) void add(paths)
      }}
    >
      {!editing && (
        images.length > 0 ? (
          <ul className="gallery-grid" aria-label={label}>
            {images.map((image, index) => (
              <li
                key={`${image.from}:${image.target}`}
                className="gallery-item"
                draggable={!readOnly}
                onDragStart={(event) => {
                  dragged.current = index
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', image.target)
                }}
                onDragOver={(event) => {
                  if (dragged.current === null) return
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                }}
                onDrop={(event) => {
                  if (dragged.current === null) return
                  event.preventDefault()
                  event.stopPropagation()
                  const from = images[dragged.current]
                  dragged.current = null
                  if (from && from !== image) change(moveInGallery(handle?.getText() ?? text, from, image))
                }}
                onDragEnd={() => {
                  dragged.current = null
                }}
              >
                <figure>
                  <Thumbnail image={image} folder={folder} />
                  <figcaption title={image.target}>{image.label}</figcaption>
                </figure>
                {!readOnly && (
                  <button type="button" className="icon-button gallery-remove" aria-label={`Remove ${image.label}`}
                    title="Remove from this layer (the file stays in attachments)"
                    onClick={() => change(removeFromGallery(handle?.getText() ?? text, image))}>
                    <X size={12} aria-hidden="true" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="gallery-empty">{readOnly ? 'No images.' : 'No images yet. Add some, or drop image files here.'}</p>
        )
      )}
      <div className={editing ? 'gallery-editor' : 'gallery-editor hidden'}>{editor(attach, setText)}</div>
      {!readOnly && (
        <div className="gallery-actions">
          {!editing && (
            <button type="button" className="link-button" onClick={() => void add()}>
              <ImagePlus size={13} aria-hidden="true" /> Add images…
            </button>
          )}
          <button type="button" className="link-button" onClick={() => setEditing((value) => !value)}>
            <Pencil size={12} aria-hidden="true" /> {editing ? 'Show as a gallery' : 'Edit as text'}
          </button>
        </div>
      )}
      {error && <p className="lexical-message status-error">{error}</p>}
    </div>
  )
}
