import { Bookmark, Columns2, FileText, Images, Layers, ListTree, type LucideIcon, NotebookPen } from 'lucide-react'

import type { Layer, LayerKind } from '../../shared/layers'
import { type DocumentView, placeLayer, sameView, type SavedView, showLayer } from '../../shared/views'
import { kindLabel } from './editor/SectionGrid'
import { DropdownMenu, type MenuItem } from './menu'
import { IconButton } from './Toolbar'

const KIND_ICON: Record<LayerKind, LucideIcon> = { prose: NotebookPen, list: ListTree, gallery: Images }

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
  /** Opens the screen that arranges the view's columns. */
  onArrange: () => void
  /** Add, rename or delete layers; absent for a one-file document. */
  onManageLayers?: () => void
}

/**
 * The view controls in the document header: which layer comes first in each row,
 * whether the columns beside it show, the way to arrange them, and the saved views.
 */
export function ViewControls({ layers, view, onView, saved, activeName, onApply, onSaveAs, onUpdate, onDelete, onFilter, onArrange, onManageLayers }: ViewControlsProps) {
  const kinds = ['output', ...layers.map((layer) => layer.name)]
  const iconOf = (kind: string) => (kind === 'output' ? FileText : KIND_ICON[layers.find((layer) => layer.name === kind)?.kind ?? 'prose'])
  const sideShown = view.columns.length > 0 && !view.sideHidden
  const others = kinds.filter((kind) => kind !== view.primary)

  // The layer that was first takes the chosen one's place, so switching back and forth keeps both in sight.
  const choosePrimary = (kind: string) => onView((current) => placeLayer(current, kind, { at: 'primary' }))
  const toggleSide = () => onView((current) => (
    current.columns.length === 0 ? (others[0] ? showLayer(current, others[0]) : current) : { ...current, sideHidden: !current.sideHidden }
  ))

  const layerItems: MenuItem[] = [
    { label: 'Arrange view…', title: 'Which layers show in which column, as tabs or stacked, and how wide', onClick: onArrange },
    { heading: 'Layout' },
    { label: 'Side by side', checked: view.layout === 'side', onClick: () => onView((current) => ({ ...current, layout: 'side' })) },
    { label: 'Stacked', checked: view.layout === 'stacked', title: 'The other columns under each section’s first one', onClick: () => onView((current) => ({ ...current, layout: 'stacked' })) },
  ]
  if (onManageLayers) layerItems.push('separator', { label: 'Manage layers…', title: 'Add, rename or delete this document’s layers', onClick: onManageLayers })

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
      <div className="segmented" role="group" aria-label="First layer in each section">
        {kinds.map((kind) => (
          <IconButton key={kind} icon={iconOf(kind)} label={`${kindLabel(kind)} view`}
            title={`${kindLabel(kind)} view: each section’s ${kindLabel(kind).toLowerCase()} first`}
            aria-pressed={view.primary === kind} onClick={() => choosePrimary(kind)} />
        ))}
      </div>
      <IconButton
        icon={Columns2}
        label={sideShown ? 'Hide the side columns' : 'Show the side columns'}
        title={`${sideShown ? 'Hide' : 'Show'} the columns beside the text; the tabs over the rows choose what they show. Ctrl+Alt+N moves between a section’s layers.`}
        aria-pressed={sideShown}
        onClick={toggleSide}
      />
      <DropdownMenu items={layerItems} trigger={(
        <button type="button" className="tool-button" aria-label="Layers" title="Arrange the columns, and their layout"><Layers size={16} strokeWidth={1.8} aria-hidden="true" /></button>
      )} />
      <DropdownMenu items={viewItems} trigger={(
        <button type="button" className={`tool-button${filterEntries.length || view.hidden.length ? ' tool-button-flag' : ''}`} aria-label="Views"
          title={active ? `Views · ${active.name}` : 'Saved views and filters'}>
          <Bookmark size={16} strokeWidth={1.8} aria-hidden="true" />
        </button>
      )} />
    </>
  )
}
