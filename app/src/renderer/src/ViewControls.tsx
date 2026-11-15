import { Bookmark, Columns2, FileText, Images, Layers, ListTree, type LucideIcon, NotebookPen } from 'lucide-react'

import type { Layer, LayerKind } from '../../shared/layers'
import { type DocumentView, sameView, type SavedView } from '../../shared/views'
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
  /** Add, rename or delete layers; absent for a one-file document. */
  onManageLayers?: () => void
}

/**
 * The view controls in the document header: which layer comes first in each row,
 * whether the others show beside it, which ones and how, and the saved views.
 */
export function ViewControls({ layers, view, onView, saved, activeName, onApply, onSaveAs, onUpdate, onDelete, onFilter, onManageLayers }: ViewControlsProps) {
  const kinds = ['output', ...layers.map((layer) => layer.name)]
  const iconOf = (kind: string) => (kind === 'output' ? FileText : KIND_ICON[layers.find((layer) => layer.name === kind)?.kind ?? 'prose'])
  const sideShown = view.shown.length > 0
  const others = kinds.filter((kind) => kind !== view.primary)

  const choosePrimary = (kind: string) => onView((current) => {
    if (current.primary === kind) return current
    // The layer that was first moves beside the new one, so switching back and forth keeps both in sight.
    const shown = current.shown.length > 0 ? [current.primary, ...current.shown.filter((item) => item !== kind && item !== current.primary)] : []
    return { ...current, primary: kind, shown }
  })
  const toggleSide = () => onView((current) => ({ ...current, shown: current.shown.length > 0 ? [] : others.slice(0, 1) }))
  const toggleLayer = (kind: string) => onView((current) => ({
    ...current,
    shown: current.shown.includes(kind) ? current.shown.filter((item) => item !== kind) : kinds.filter((item) => item === kind || current.shown.includes(item)),
  }))

  const layerItems: MenuItem[] = [
    { heading: 'Beside each section' },
    ...others.map((kind): MenuItem => ({ label: kindLabel(kind), checked: view.shown.includes(kind), onClick: () => toggleLayer(kind) })),
    { heading: 'Layout' },
    { label: 'Side by side', checked: view.layout === 'side', onClick: () => onView((current) => ({ ...current, layout: 'side' })) },
    { label: 'Stacked', checked: view.layout === 'stacked', title: 'The other layers under each section’s first one', onClick: () => onView((current) => ({ ...current, layout: 'stacked' })) },
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
      title: saved === null ? 'Fields are in a document folder’s section files' : 'Only the sections whose frontmatter fields match',
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
        label={sideShown ? 'Hide the other layers' : 'Show the other layers'}
        title={`${sideShown ? 'Hide' : 'Show'} the other layers beside every section. Each section can be shown or hidden on its own too; Ctrl+Alt+N moves between a section’s layers.`}
        aria-pressed={sideShown}
        onClick={toggleSide}
      />
      <DropdownMenu items={layerItems} trigger={(
        <button type="button" className="tool-button" aria-label="Layers" title="Which layers show beside each section, and how"><Layers size={16} strokeWidth={1.8} aria-hidden="true" /></button>
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
