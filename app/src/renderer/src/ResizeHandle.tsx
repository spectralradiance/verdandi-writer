import type { PointerEvent as ReactPointerEvent } from 'react'

interface ResizeHandleProps {
  /** The pane edge the handle sits on: the left pane's right edge, or the right pane's left edge. */
  edge: 'right' | 'left'
  width: number
  min: number
  max: number
  /** The width chosen: once, when the drag ends. */
  onResize: (width: number) => void
  onReset: () => void
  /**
   * The CSS variable on the nearest `.shell` that sets the pane's width while
   * dragging: setting it costs no re-render of the app (and of the document in it).
   */
  cssVariable: string
}

/** A thin strip on a pane's inner edge: drag to resize the pane, double-click to reset it. */
export function ResizeHandle({ edge, width, min, max, onResize, onReset, cssVariable }: ResizeHandleProps) {
  const start = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    const handle = event.currentTarget
    const startX = event.clientX
    const shell = handle.closest<HTMLElement>('.shell')
    document.body.classList.add('resizing')
    let next = width
    const move = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX
      next = Math.round(Math.min(max, Math.max(min, edge === 'right' ? width + delta : width - delta)))
      shell?.style.setProperty(cssVariable, `${next}px`)
    }
    // The window's events, not the handle's: pointer capture can be lost mid-drag, and the release with it.
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      document.body.classList.remove('resizing')
      if (next !== width) onResize(next)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
  }

  return (
    <div
      className={`pane-resize pane-resize-${edge}`}
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      onPointerDown={start}
      onDoubleClick={onReset}
      title="Drag to resize; double-click to reset"
    />
  )
}
