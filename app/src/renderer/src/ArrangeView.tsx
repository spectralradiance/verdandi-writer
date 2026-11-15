import { Ellipsis, GripVertical, Plus, X } from 'lucide-react'
import { type DragEvent, type ReactNode, useState } from 'react'

import type { Layer } from '../../shared/layers'
import { defaultView, type DocumentView, MAX_SIDE_COLUMNS, type Place, placeLayer, placeOf, type ViewColumn } from '../../shared/views'
import { kindLabel } from './editor/SectionGrid'
import { DropdownMenu, type MenuItem } from './menu'
import { Modal } from './Modal'

const LAYER_DRAG = 'application/x-verdandi-layer'

/** A layer in the arrangement: dragged between places, or moved with its menu. */
function Chip({ kind, menu, primary = false, onDropBefore }: {
  kind: string
  menu: MenuItem[]
  primary?: boolean
  onDropBefore?: (kind: string) => void
}) {
  const [over, setOver] = useState(false)
  return (
    <div
      className={`arrange-chip${primary ? ' primary' : ''}${over ? ' drop-before' : ''}`}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData(LAYER_DRAG, kind)
      }}
      onDragOver={onDropBefore ? (event) => {
        if (!event.dataTransfer.types.includes(LAYER_DRAG)) return
        event.preventDefault()
        event.stopPropagation()
        setOver(true)
      } : undefined}
      onDragLeave={() => setOver(false)}
      onDrop={onDropBefore ? (event) => {
        setOver(false)
        const moved = event.dataTransfer.getData(LAYER_DRAG)
        if (!moved || moved === kind) return
        event.preventDefault()
        event.stopPropagation()
        onDropBefore(moved)
      } : undefined}
    >
      <GripVertical size={13} aria-hidden="true" className="arrange-grip" />
      <span className="arrange-chip-name">{kindLabel(kind)}</span>
      <DropdownMenu items={menu} trigger={(
        <button type="button" className="icon-button" aria-label={`Move ${kindLabel(kind)}`} title="Move this layer"><Ellipsis size={14} aria-hidden="true" /></button>
      )} />
    </div>
  )
}

/** Somewhere a layer can be dropped: a list of chips, and the space after them. */
function DropList({ label, onDrop, children, empty }: { label: string; onDrop: (kind: string) => void; children: ReactNode; empty?: string }) {
  const [over, setOver] = useState(false)
  const accept = (event: DragEvent) => {
    if (!event.dataTransfer.types.includes(LAYER_DRAG)) return
    event.preventDefault()
    setOver(true)
  }
  return (
    <div
      className={`arrange-list${over ? ' over' : ''}`}
      aria-label={label}
      onDragOver={accept}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false)
      }}
      onDrop={(event) => {
        setOver(false)
        const kind = event.dataTransfer.getData(LAYER_DRAG)
        if (!kind) return
        event.preventDefault()
        onDrop(kind)
      }}
    >
      {children}
      {empty && <p className="arrange-empty">{empty}</p>}
    </div>
  )
}

const share = (width: number, total: number) => `${Math.round((width / total) * 100)}%`

/**
 * Arranges a view: which layer is first, which sit under it, which columns sit
 * beside it (up to two), whether each shows its layers as tabs or stacked, and how
 * wide each column is. The columns are drawn at their widths, so the screen is its
 * own preview. Layers are dragged between places or moved with their menus.
 */
export function ArrangeViewDialog({ layers, view, onApply, onSaveAs, onClose }: {
  layers: readonly Layer[]
  view: DocumentView
  onApply: (view: DocumentView) => void
  /** Applies the arrangement and asks for a name to save it under (a document folder only). */
  onSaveAs?: (view: DocumentView) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState(view)
  const kinds = ['output', ...layers.map((layer) => layer.name)]
  const unplaced = kinds.filter((kind) => placeOf(draft, kind).at === 'none')
  const total = draft.primaryWidth + draft.columns.reduce((sum, column) => sum + column.width, 0)
  const move = (kind: string, place: Place, position?: number) => setDraft((current) => placeLayer(current, kind, place, position))
  const setColumn = (index: number, change: Partial<ViewColumn>) => setDraft((current) => ({
    ...current,
    columns: current.columns.map((column, at) => (at === index ? { ...column, ...change } : column)),
  }))
  const removeColumn = (index: number) => setDraft((current) => {
    let next = current
    for (const kind of current.columns[index].layers) next = placeLayer(next, kind, { at: 'none' })
    return next
  })
  const canAddColumn = draft.columns.length < MAX_SIDE_COLUMNS

  /** Where a layer can be moved to from its menu. */
  const menuFor = (kind: string): MenuItem[] => {
    const here = placeOf(draft, kind)
    const items: MenuItem[] = []
    if (here.at !== 'primary') items.push({ label: 'Make it first', title: 'The layer each row starts with; the one first now takes its place', onClick: () => move(kind, { at: 'primary' }) })
    if (here.at === 'primary') {
      items.push({ label: 'It is first in each row', disabled: true, onClick: () => {} }, 'separator')
      return items
    }
    if (here.at !== 'under') items.push({ label: 'Under the first', onClick: () => move(kind, { at: 'under' }) })
    draft.columns.forEach((_column, index) => {
      if (here.at !== 'column' || here.index !== index) items.push({ label: `Into column ${index + 2}`, onClick: () => move(kind, { at: 'column', index }) })
    })
    if (canAddColumn) items.push({ label: 'Into a new column', onClick: () => move(kind, { at: 'column', index: draft.columns.length }) })
    const list = here.at === 'under' ? draft.under : here.at === 'column' ? draft.columns[here.index].layers : []
    const at = list.indexOf(kind)
    if (list.length > 1) {
      items.push('separator',
        { label: 'Move up', disabled: at <= 0, onClick: () => move(kind, here, at - 1) },
        { label: 'Move down', disabled: at >= list.length - 1, onClick: () => move(kind, here, at + 1) })
    }
    if (here.at !== 'none') items.push('separator', { label: 'Don’t show', title: 'Left out of this view (a section’s own page still shows it)', onClick: () => move(kind, { at: 'none' }) })
    return items
  }

  const chips = (list: readonly string[], place: Place) => list.map((kind, index) => (
    <Chip key={kind} kind={kind} menu={menuFor(kind)} onDropBefore={(moved) => setDraft((current) => {
      // Before this chip: its position counted once the moved layer is out of the list.
      const target = (place.at === 'under' ? current.under : place.at === 'column' ? current.columns[place.index].layers : list).filter((item) => item !== moved)
      return placeLayer(current, moved, place, Math.max(0, target.indexOf(kind) === -1 ? index : target.indexOf(kind)))
    })} />
  ))

  return (
    <Modal label="Arrange view" className="arrange-dialog" onClose={onClose}>
      <header className="modal-header">
        <h2>Arrange view</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={14} aria-hidden="true" /></button>
      </header>
      <div className="settings-body">
        <p className="lexical-hint">
          Drag layers between the columns, or use each one’s menu. A column of tabs shows one layer at a time, chosen in the bar over the rows;
          a stacked column shows them all, one under another. The widths here are the columns’ widths; drag the lines between them in the bar
          to change them too. A window too narrow for every column folds the last ones into tabs.
        </p>

        <div className="arrange-columns">
          <section className="arrange-column" style={{ flexGrow: draft.primaryWidth }}>
            <header className="arrange-column-head">
              <h3>Column 1</h3>
              <span className="lexical-hint">{share(draft.primaryWidth, total)}</span>
            </header>
            <DropList label="First in each row" onDrop={(kind) => move(kind, { at: 'primary' })}>
              <Chip kind={draft.primary} menu={menuFor(draft.primary)} primary />
            </DropList>
            <h4 className="arrange-sub">Under it</h4>
            <DropList label="Under the first layer" onDrop={(kind) => move(kind, { at: 'under' })} empty={draft.under.length ? undefined : 'Drop a layer here to show it under the first'}>
              {chips(draft.under, { at: 'under' })}
            </DropList>
          </section>

          {draft.columns.map((column, index) => (
            <section key={index} className="arrange-column" style={{ flexGrow: column.width }}>
              <header className="arrange-column-head">
                <h3>Column {index + 2}</h3>
                <span className="lexical-hint">{share(column.width, total)}</span>
                <button type="button" className="icon-button" onClick={() => removeColumn(index)} aria-label={`Remove column ${index + 2}`}
                  title="Remove this column (its layers stop showing)"><X size={13} aria-hidden="true" /></button>
              </header>
              <div className="segmented arrange-mode" role="group" aria-label={`How column ${index + 2} shows its layers`}>
                <button type="button" aria-pressed={column.mode === 'tabs'} onClick={() => setColumn(index, { mode: 'tabs', active: column.active ?? column.layers[0] })}>Tabs</button>
                <button type="button" aria-pressed={column.mode === 'stack'} onClick={() => setColumn(index, { mode: 'stack' })}>Stacked</button>
              </div>
              <label className="arrange-width">
                Width
                <input type="range" min={0.25} max={4} step={0.05} value={column.width}
                  onChange={(event) => setColumn(index, { width: Number(event.target.value) })} />
              </label>
              <DropList label={`Column ${index + 2}`} onDrop={(kind) => move(kind, { at: 'column', index })}>
                {chips(column.layers, { at: 'column', index })}
              </DropList>
            </section>
          ))}

          {canAddColumn && (
            <section className="arrange-column arrange-new">
              <DropList label="A new column" onDrop={(kind) => move(kind, { at: 'column', index: draft.columns.length })}>
                <p className="arrange-empty"><Plus size={13} aria-hidden="true" /> Drop a layer here for a new column</p>
              </DropList>
            </section>
          )}
        </div>

        <h4 className="arrange-sub">Not shown</h4>
        <DropList label="Not shown" onDrop={(kind) => move(kind, { at: 'none' })} empty={unplaced.length ? undefined : 'Every layer shows. Drop one here to leave it out.'}>
          {chips(unplaced, { at: 'none' })}
        </DropList>

        <fieldset className="arrange-layout">
          <legend>Columns</legend>
          <label><input type="radio" checked={draft.layout === 'side'} onChange={() => setDraft((current) => ({ ...current, layout: 'side' }))} /> Side by side</label>
          <label><input type="radio" checked={draft.layout === 'stacked'} onChange={() => setDraft((current) => ({ ...current, layout: 'stacked' }))} /> Stacked under the first</label>
        </fieldset>
      </div>
      <footer className="modal-footer arrange-footer">
        <button type="button" className="link-button" onClick={() => setDraft((current) => ({
          ...defaultView(layers.map((layer) => layer.name)), page: current.page, hidden: current.hidden, collapsed: current.collapsed, filter: current.filter,
        }))}>Reset</button>
        <span className="arrange-spacer" />
        <button type="button" onClick={onClose}>Cancel</button>
        {onSaveAs && <button type="button" onClick={() => onSaveAs({ ...draft, sideHidden: false })}>Save as view…</button>}
        <button type="button" className="primary" onClick={() => onApply({ ...draft, sideHidden: false })}>Apply</button>
      </footer>
    </Modal>
  )
}
