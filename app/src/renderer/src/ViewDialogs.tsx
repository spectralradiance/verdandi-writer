import { Trash2, X } from 'lucide-react'
import { useState } from 'react'

import { type Layer, type LayerChange, type LayerKind, layerNameError } from '../../shared/layers'
import { fieldValues } from '../../shared/views'
import { Modal } from './Modal'

function Header({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <header className="modal-header">
      <h2>{title}</h2>
      <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={14} aria-hidden="true" /></button>
    </header>
  )
}

/** Asks for a name to save the current view under. */
export function SaveViewDialog({ taken, onSave, onClose }: { taken: readonly string[]; onSave: (name: string) => void; onClose: () => void }) {
  const [name, setName] = useState('')
  const clean = name.trim()
  const replaces = taken.includes(clean)
  return (
    <Modal label="Save view" className="view-dialog" onClose={onClose}>
      <Header title="Save this view" onClose={onClose} />
      <form className="settings-body" onSubmit={(event) => {
        event.preventDefault()
        if (clean) onSave(clean)
      }}>
        <div className="settings-section">
          <label className="view-dialog-field">
            Name
            <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Drafts, Act one, Outline…" />
          </label>
          <p className="lexical-hint">
            It keeps which layers show and how, which sections are hidden or collapsed, the filter, and the section on its own page.
            {replaces && ' A view with this name is replaced.'}
          </p>
        </div>
        <footer className="modal-footer">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary" disabled={!clean}>{replaces ? 'Replace' : 'Save'}</button>
        </footer>
      </form>
    </Modal>
  )
}

/** Chooses the fields a view's sections must match. */
export function FilterDialog({ fields, filter, onApply, onClose }: {
  fields: Record<string, Record<string, unknown>>
  filter: Record<string, string>
  onApply: (filter: Record<string, string>) => void
  onClose: () => void
}) {
  const known = fieldValues(Object.values(fields))
  const [entries, setEntries] = useState<[string, string][]>(() => {
    const current = Object.entries(filter)
    return current.length ? current : [[[...known.keys()][0] ?? '', '']]
  })
  const set = (index: number, entry: [string, string]) => setEntries((list) => list.map((item, at) => (at === index ? entry : item)))
  return (
    <Modal label="Filter sections" className="view-dialog" onClose={onClose}>
      <Header title="Filter by field" onClose={onClose} />
      <div className="settings-body">
        <div className="settings-section">
          {known.size === 0 && (
            <p className="lexical-hint">No section has fields yet. Fields are the frontmatter of a section file, such as <code>status: draft</code>, and can be added in Obsidian or any editor.</p>
          )}
          {entries.map(([field, value], index) => (
            <div className="view-filter-row" key={index}>
              <input list="view-filter-fields" value={field} aria-label="Field" placeholder="field"
                onChange={(event) => set(index, [event.target.value, value])} />
              <span aria-hidden="true">is</span>
              <input list={`view-filter-values-${index}`} value={value} aria-label="Value" placeholder="any value"
                onChange={(event) => set(index, [field, event.target.value])} />
              <datalist id={`view-filter-values-${index}`}>
                {(known.get(field) ?? []).map((option) => <option key={option} value={option} />)}
              </datalist>
              <button type="button" className="icon-button" aria-label="Remove" title="Remove this condition"
                onClick={() => setEntries((list) => list.filter((_, at) => at !== index))}><Trash2 size={13} aria-hidden="true" /></button>
            </div>
          ))}
          <datalist id="view-filter-fields">
            {[...known.keys()].map((option) => <option key={option} value={option} />)}
          </datalist>
          <button type="button" className="link-button" onClick={() => setEntries((list) => [...list, ['', '']])}>Add a condition</button>
          <p className="lexical-hint">A section shows when every condition matches. A list field such as <code>tags</code> matches when any of its items does; an empty value matches any section that has the field.</p>
        </div>
      </div>
      <footer className="modal-footer">
        <button type="button" onClick={() => onApply({})}>Clear</button>
        <button type="button" className="primary" onClick={() => onApply(Object.fromEntries(entries.filter(([field]) => field.trim()).map(([field, value]) => [field.trim(), value.trim()])))}>
          Apply
        </button>
      </footer>
    </Modal>
  )
}

const KINDS: { kind: LayerKind; label: string }[] = [
  { kind: 'prose', label: 'Prose' },
  { kind: 'list', label: 'List' },
  { kind: 'gallery', label: 'Gallery' },
]

/**
 * A document folder's layers: add, rename, change the kind of, or delete one. Each
 * change is made at once, across the section files.
 */
export function LayersDialog({ layers, busy, error, onChange, onClose }: {
  layers: readonly Layer[]
  busy: boolean
  error: string | null
  /** Makes one change; resolves once the document has reloaded. */
  onChange: (change: LayerChange, label: string) => void
  onClose: () => void
}) {
  const [names, setNames] = useState<Record<string, string>>({})
  const [newName, setNewName] = useState('')
  const [newKind, setNewKind] = useState<LayerKind>('prose')
  const addError = newName.trim() ? layerNameError(newName, layers) : null
  return (
    <Modal label="Layers" className="view-dialog layers-dialog" onClose={onClose}>
      <Header title="Layers" onClose={onClose} />
      <div className="settings-body">
        <div className="settings-section">
          <p className="lexical-hint">Every section has the same layers. In the files each is a callout, such as <code>&gt; [!notes]</code>; an empty one is not written.</p>
          <ul className="layers-list">
            <li className="layers-row layers-row-fixed"><span className="layers-name">Text</span><span className="lexical-hint">The section’s own text</span></li>
            {layers.map((layer) => {
              const draft = names[layer.name] ?? layer.name
              const renameError = draft.trim().toLowerCase() !== layer.name ? layerNameError(draft, layers, layer.name) : null
              const rename = () => {
                if (draft.trim().toLowerCase() === layer.name || renameError) return
                onChange({ rename: layer.name, to: draft.trim().toLowerCase() }, `Renamed the ${layer.name} layer`)
              }
              return (
                <li className="layers-row" key={layer.name}>
                  <input className="layers-name" value={draft} aria-label={`Name of the ${layer.name} layer`} disabled={busy}
                    title={renameError ?? 'Press Enter to rename'}
                    aria-invalid={renameError !== null}
                    onChange={(event) => setNames((current) => ({ ...current, [layer.name]: event.target.value }))}
                    onKeyDown={(event) => { if (event.key === 'Enter') rename() }}
                    onBlur={rename} />
                  <select value={layer.kind} disabled={busy} aria-label={`Kind of the ${layer.name} layer`}
                    onChange={(event) => onChange({ change: layer.name, kind: event.target.value as LayerKind }, `Changed the ${layer.name} layer`)}>
                    {KINDS.map((option) => <option key={option.kind} value={option.kind}>{option.label}</option>)}
                  </select>
                  <label title="Its blocks sit after the paragraph they belong to, rather than at the end of the section">
                    <input type="checkbox" checked={layer.anchored} disabled={busy}
                      onChange={(event) => onChange({ change: layer.name, anchored: event.target.checked }, `Changed the ${layer.name} layer`)} /> Anchored
                  </label>
                  <button type="button" className="icon-button" disabled={busy} aria-label={`Delete the ${layer.name} layer`} title="Delete this layer…"
                    onClick={() => onChange({ remove: layer.name }, `Deleted the ${layer.name} layer`)}>
                    <Trash2 size={13} aria-hidden="true" />
                  </button>
                </li>
              )
            })}
          </ul>
          <form className="layers-row layers-add" onSubmit={(event) => {
            event.preventDefault()
            if (!newName.trim() || addError) return
            onChange({ add: { name: newName.trim().toLowerCase(), kind: newKind, anchored: false } }, `Added the ${newName.trim().toLowerCase()} layer`)
            setNewName('')
          }}>
            <input className="layers-name" value={newName} placeholder="outline, images, research…" aria-label="New layer name" disabled={busy}
              aria-invalid={addError !== null} onChange={(event) => setNewName(event.target.value)} />
            <select value={newKind} disabled={busy} aria-label="New layer kind" onChange={(event) => setNewKind(event.target.value as LayerKind)}>
              {KINDS.map((option) => <option key={option.kind} value={option.kind}>{option.label}</option>)}
            </select>
            <button type="submit" disabled={busy || !newName.trim() || addError !== null}>Add layer</button>
          </form>
          {addError && <p className="lexical-message status-error">{addError}</p>}
          {error && <p className="lexical-message status-error">{error}</p>}
        </div>
      </div>
      <footer className="modal-footer">
        <button type="button" className="primary" onClick={onClose}>Done</button>
      </footer>
    </Modal>
  )
}
