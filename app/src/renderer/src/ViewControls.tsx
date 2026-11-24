import { Bookmark, ChevronDown, FileText, Images, Layers, ListTree, type LucideIcon, NotebookPen } from 'lucide-react'

import type { Layer, LayerKind } from '../../shared/layers'
import { type DocumentView, placeLayer, sameView, type SavedView } from '../../shared/views'
import { kindLabel } from './editor/SectionGrid'
import { DropdownMenu, type MenuItem } from './menu'

const KIND_ICON: Record<LayerKind, LucideIcon> = { prose: NotebookPen, list: ListTree, gallery: Images }

/** A layer's icon: the text's, or its kind's. */
function LayerIcon({ kind, layers }: { kind: string; layers: readonly Layer[] }) {
  const Icon = kind === 'output' ? FileText : KIND_ICON[layers.find((layer) => layer.name === kind)?.kind ?? 'prose']
  return <Icon size={15} strokeWidth={1.8} aria-hidden="true" />
}

interface ViewControlsProps {
  /** The document's layers (a one-file document: its notes). */
  layers: readonly Layer[]
  view: DocumentView
  onView: (change: (view: DocumentView) => DocumentView) => void
  /** A document folder's saved views; null when the document cannot save any (a one-file document). */
  saved: SavedView[] | null
  /** The saved view last chosen, to offer updating it. */
  activeName: string | null
  onApply: (view: SavedView) => void
  onSaveAs: () => void
  onUpdate: (name: string) => void
  onDelete: (name: string) => void
  onFilter: () => void
  /** Add, rename or delete layers; absent for a one-file document. */
  onManageLayers?: () => void
}

/**
 * The view controls in the document header: which layer each section shows, where
 * the document's layers are managed, and the saved views.
 */
export function ViewControls({ layers, view, onView, saved, activeName, onApply, onSaveAs, onUpdate, onDelete, onFilter, onManageLayers }: ViewControlsProps) {
  const kinds = ['output', ...layers.map((layer) => layer.name)]

  // The layer that was first takes the chosen one's place, so switching back and forth keeps both in sight.
  const choosePrimary = (kind: string) => onView((current) => placeLayer(current, kind, { at: 'primary' }))


  const focusItems: MenuItem[] = [
    { heading: 'Focus layer' },
    ...kinds.map((kind): MenuItem => ({
      label: kindLabel(kind),
      checked: view.primary === kind,
      title: `Each section’s ${kindLabel(kind).toLowerCase()} first`,
      onClick: () => choosePrimary(kind),
    })),
  ]

  const filterEntries = Object.entries(view.filter)
  // The view chosen last, or else a saved view this one is the same as (after reopening the document).
  const active = saved?.find((item) => item.name === activeName) ?? saved?.find((item) => sameView(item, view)) ?? null
  const viewItems: MenuItem[] = []
  if (saved && saved.length > 0) {
    viewItems.push({ heading: 'Saved views' })
    for (const item of saved) viewItems.push({ label: item.name, checked: sameView(item, view), onClick: () => onApply(item) })
    viewItems.push('separator')
  }
  viewItems.push({
    label: 'Save this view as…',
    disabled: saved === null,
    title: saved === null ? 'Views are saved with a document folder' : 'Saved in the document’s .verdandi/views.yaml, so it travels with it',
    onClick: onSaveAs,
  })
  if (active && !sameView(active, view)) viewItems.push({ label: `Update “${active.name}”`, onClick: () => onUpdate(active.name) })
  if (active) viewItems.push({ label: `Delete “${active.name}”…`, onClick: () => onDelete(active.name) })
  viewItems.push(
    'separator',
    {
      label: 'Filter by field…',
      hint: filterEntries.map(([field, value]) => (value ? `${field}: ${value}` : field)).join(', ') || undefined,
      disabled: saved === null,
      title: saved === null ? 'Fields are kept in a document folder’s main file' : 'Only the sections whose frontmatter fields match',
      onClick: onFilter,
    },
  )
  if (filterEntries.length) viewItems.push({ label: 'Clear the filter', onClick: () => onView((current) => ({ ...current, filter: {} })) })
  if (view.hidden.length) viewItems.push({ label: `Show hidden sections (${view.hidden.length})`, onClick: () => onView((current) => ({ ...current, hidden: [] })) })
  if (view.collapsed.length) viewItems.push({ label: 'Expand every section', onClick: () => onView((current) => ({ ...current, collapsed: [] })) })

  return (
    <>
      <DropdownMenu items={focusItems} trigger={(
        <button type="button" className="tool-button focus-layer-button" aria-label={`Focus layer: ${kindLabel(view.primary)}`}
          title="The focus layer: the one each section starts with">
          <LayerIcon kind={view.primary} layers={layers} />
          <span className="focus-layer-name">{kindLabel(view.primary)}</span>
          <ChevronDown size={13} aria-hidden="true" />
        </button>
      )} />
      {onManageLayers && (
        <button type="button" className="tool-button" aria-label="Manage layers" title="Add, rename or delete this document’s layers" onClick={onManageLayers}>
          <Layers size={16} strokeWidth={1.8} aria-hidden="true" />
        </button>
      )}
      <DropdownMenu items={viewItems} trigger={(
        <button type="button" className={`tool-button${filterEntries.length || view.hidden.length ? ' tool-button-flag' : ''}`} aria-label="Views"
          title={active ? `Views · ${active.name}` : 'Saved views and filters'}>
          <Bookmark size={16} strokeWidth={1.8} aria-hidden="true" />
        </button>
      )} />
    </>
  )
}
