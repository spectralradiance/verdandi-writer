import { useEffect, useState } from 'react'

import type { ExportContent, ExportOptions, ExportOutcome } from '../../shared/ipc'
import { layerLabel } from '../../shared/layers'
import { errorMessage } from './target'
import { X } from 'lucide-react'

import { Modal } from './Modal'

interface ExportDialogProps {
  folder: string
  title: string
  /** A document folder's layers, or null for a one-file document (its notes alone). */
  layers: readonly string[] | null
  /** Saves open editors first, so the export includes the latest text. */
  flush: () => Promise<boolean>
  onClose: () => void
}

export function ExportDialog({ folder, title, layers, flush, onClose }: ExportDialogProps) {
  const choices: { content: ExportContent; label: string }[] = [
    { content: 'output', label: 'Text (the finished text)' },
    ...(layers ?? ['notes']).map((layer) => ({ content: `layer:${layer}` as const, label: layerLabel(layer) })),
    ...(layers && layers.length > 1 ? [{ content: 'notes' as const, label: 'Every layer' }] : []),
  ]
  const [options, setOptions] = useState<ExportOptions>({ format: 'pdf', content: 'output', includeTitle: true })
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<ExportOutcome | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Start from the defaults in Settings → Export.
  useEffect(() => {
    void window.verdandi.preferences.get().then((preferences) => setOptions((current) => ({
      ...current, format: preferences.export.format, includeTitle: preferences.export.includeTitle,
    })))
  }, [])

  const run = async () => {
    setBusy(true)
    setError(null)
    try {
      if (!(await flush())) throw new Error('Some edits could not be saved; resolve that before exporting.')
      const result = await window.verdandi.exports.document(folder, title, options)
      if (result) setOutcome(result)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal label="Export document" className="export-dialog" onClose={onClose}>
      <header className="modal-header">
        <h2>Export · {title}</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={14} aria-hidden="true" /></button>
      </header>
      <div className="settings-body">
        <div className="settings-section">
          <fieldset className="export-choice">
            <legend>Content</legend>
            {choices.map((choice) => (
              <label key={choice.content}>
                <input type="radio" checked={options.content === choice.content} onChange={() => setOptions({ ...options, content: choice.content })} /> {choice.label}
              </label>
            ))}
          </fieldset>
          <fieldset className="export-choice">
            <legend>Format</legend>
            <label><input type="radio" checked={options.format === 'pdf'} onChange={() => setOptions({ ...options, format: 'pdf' })} /> PDF</label>
            <label><input type="radio" checked={options.format === 'html'} onChange={() => setOptions({ ...options, format: 'html' })} /> HTML page</label>
            <label><input type="radio" checked={options.format === 'md'} onChange={() => setOptions({ ...options, format: 'md' })} /> Markdown</label>
          </fieldset>
          <label>
            <input type="checkbox" checked={options.includeTitle} onChange={(event) => setOptions({ ...options, includeTitle: event.target.checked })} />
            {' '}Start with the document title
          </label>
          <p className="lexical-hint">
            Sections are joined in order; a section without a heading continues the one before (a layer export gives every section its title).
            Empty sections are left out. Fonts, page size and margins are in Settings → Export.
          </p>
          {error && <p className="lexical-message status-error">{error}</p>}
          {outcome && (
            <p className="lexical-message">
              Exported {outcome.sections} section{outcome.sections === 1 ? '' : 's'} to {outcome.path}
              {outcome.skipped.length > 0 && <> (left out, nothing written yet: {outcome.skipped.join(', ')})</>}.{' '}
              <button type="button" className="link-button" onClick={() => void window.verdandi.exports.showInFolder(outcome.path)}>Show in folder</button>
            </p>
          )}
        </div>
      </div>
      <footer className="modal-footer">
        <button type="button" onClick={onClose}>Close</button>
        <button type="button" className="primary" disabled={busy} onClick={() => void run()}>{busy ? 'Exporting…' : 'Export…'}</button>
      </footer>
    </Modal>
  )
}
