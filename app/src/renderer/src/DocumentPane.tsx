import { type ReactNode, type Ref, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { folderName } from '../../shared/format'
import type { TextDocument, TextFormat } from '../../shared/ipc'
import { dirname } from '../../shared/paths'
import { replaceSectionOutput, type SectionSummary, sectionAtLine, splitSections, splitWordCounts, summarizeSections } from '../../shared/document'
import { type FieldChange, type Layer, type LayerChange, layerHasContent, looksLikeVerdandiDocument, NOTES_LAYER, undeclaredCallouts } from '../../shared/layers'
import { type DocumentView, fieldValues, type SavedView } from '../../shared/views'
import { loadView, storeView } from './documentView'
import { readPref, writePref } from './prefs'
import { extractHeadings, type Heading } from '../../shared/text'
import { onDiskChange, touchesFile } from './changes'
import type { MarkdownEditorHandle, WordInContext } from './editor/MarkdownEditor'
import { SectionGrid } from './editor/SectionGrid'
import { HistoryDialog } from './HistoryDialog'
import { errorMessage } from './target'
import { ViewControls } from './ViewControls'
import { FieldsDialog, FilterDialog, LayersDialog, SaveViewDialog } from './ViewDialogs'
import { History, X } from 'lucide-react'

const AUTOSAVE_DELAY_MS = 1200
const STATS_DELAY_MS = 400

export type SaveState = 'saved' | 'dirty' | 'saving' | 'conflict' | 'error'

export const SAVE_LABEL: Record<SaveState, string> = {
  saved: 'Saved',
  dirty: 'Edited',
  saving: 'Saving…',
  conflict: 'Changed on disk',
  error: 'Save failed',
}

export interface DocumentInfo {
  /** Words outside notes blocks: the text itself. */
  words: number
  /** Words inside notes blocks. */
  notesWords: number
  format: TextFormat
}

/** The section at the cursor of a single-file document. */
export interface CurrentSection {
  index: number
  title: string | null
  output: string
  notes: string
  /** Its layers' text, for the layers that have any. */
  layers: Record<string, string>
}

export interface DocumentPaneHandle {
  /** Saves pending edits. Resolves false if they could not be saved. */
  flush(): Promise<boolean>
  revealLine(line: number): void
  currentWord(): WordInContext | null
  replaceWord(replacement: string): boolean
  getText(): string
  getSelection(): string
  replaceAll(text: string): void
  /** The section the cursor is in (a heading and the text under it). */
  currentSection(): CurrentSection | null
  /**
   * Shows `text` as suggested changes to section `index`'s output, after saving the
   * current text as a "Before AI" version in History. Returns how many changes were
   * suggested, or null if that section no longer exists.
   */
  propose(text: string, label: string, index: number): number | null
  /**
   * Suggests replacing the one occurrence of `oldText` with `newText` (an agent's edit),
   * alongside suggestions already shown. With `snapshot`, first saves a "Before AI"
   * version. Returns how many changes were suggested, or why it could not.
   */
  proposeEdit(oldText: string, newText: string, label: string, snapshot: boolean): { count: number } | { error: string }
  openHistory(): void
  /** The document's layer names for the classifier (null for a one-file document's notes). */
  layerNames(): string[] | null
}

interface DocumentPaneProps {
  ref?: Ref<DocumentPaneHandle>
  path: string
  live: boolean
  focusMode: boolean
  headerActions?: ReactNode
  onInfo: (info: DocumentInfo | null) => void
  onHeadings?: (headings: Heading[]) => void
  /** The document's sections (split at its headings) with their sizes, as you type. */
  onSections?: (sections: SectionSummary[]) => void
  onDirtyChange: (dirty: boolean) => void
  onFocus?: () => void
  onSelectWord?: (word: WordInContext) => void
  onClose?: () => void
  /**
   * Edit this one-file document as it is, rather than turning it into a document
   * folder (the writer undid that conversion).
   */
  keepAsFile?: boolean
  /** The one-file document `original` became the document folder `folder`. */
  onConverted?: (folder: string, original: string) => void
}

/**
 * How a document opens: a document folder, or a one-file document kept as it is, is
 * edited; a one-file document that uses notes blocks or section markers becomes a
 * document folder; any other note is only shown, with an offer to make it a document.
 */
type Mode = 'edit' | 'read' | 'convert'

function modeOf(document: TextDocument, keepAsFile: boolean): Mode {
  if (document.folder || document.mtimeMs === null || keepAsFile) return 'edit'
  return looksLikeVerdandiDocument(document.text) ? 'convert' : 'read'
}

interface DiskState {
  mtimeMs: number | null
  format: TextFormat
}

export function DocumentPane({
  ref, path, live, focusMode, headerActions,
  onInfo, onHeadings, onSections, onDirtyChange, onFocus, onSelectWord, onClose, keepAsFile = false, onConverted,
}: DocumentPaneProps) {
  const [loaded, setLoaded] = useState<{ document: TextDocument; generation: number } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [exists, setExists] = useState(true)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [converting, setConverting] = useState(false)
  const [view, setView] = useState<DocumentView | null>(null)
  const [savedViews, setSavedViews] = useState<SavedView[]>([])
  const [activeView, setActiveView] = useState<string | null>(null)
  const [dialog, setDialog] = useState<'save' | 'filter' | 'layers' | null>(null)
  const [layerBusy, setLayerBusy] = useState(false)
  const [layerError, setLayerError] = useState<string | null>(null)
  /** The section whose fields are being edited, by its id. */
  const [editingFields, setEditingFields] = useState<{ id: string; title: string } | null>(null)
  // Callout types left as text on purpose, so the offer to make them layers is not repeated.
  const [keptCallouts, setKeptCallouts] = useState<string[]>(() => {
    try {
      const stored: unknown = JSON.parse(readPref(`keptCallouts:${path.toLowerCase()}`) ?? '[]')
      return Array.isArray(stored) ? stored.filter((name): name is string => typeof name === 'string') : []
    } catch {
      return []
    }
  })
  /** The layer names the text's blocks use (null: a one-file document, notes only). */
  const layerNames = useRef<string[] | null>(null)

  const editor = useRef<MarkdownEditorHandle>(null)
  const disk = useRef<DiskState | null>(null)
  const state = useRef<SaveState>('saved')
  const version = useRef(0)
  const savedVersion = useRef(0)
  const inFlight = useRef<Promise<boolean> | null>(null)
  const autosaveTimer = useRef<number | undefined>(undefined)
  const statsTimer = useRef<number | undefined>(undefined)
  // Lets save() reschedule itself for edits made while it was writing.
  const saveLater = useRef<() => void>(() => {})

  // The parent's latest callbacks, read through a ref so that their identity
  // changing on every parent render does not re-run the file load.
  const parent = useRef({ onInfo, onHeadings, onSections, onDirtyChange, onConverted })
  useLayoutEffect(() => {
    parent.current = { onInfo, onHeadings, onSections, onDirtyChange, onConverted }
  })

  const updateState = useCallback((next: SaveState) => {
    state.current = next
    setSaveState(next)
  }, [])

  const reportStats = useCallback((text: string, format: TextFormat) => {
    const counts = splitWordCounts(text, layerNames.current)
    parent.current.onInfo({ words: counts.output, notesWords: counts.notes, format })
    parent.current.onHeadings?.(extractHeadings(text, layerNames.current))
    parent.current.onSections?.(summarizeSections(text, layerNames.current))
  }, [])

  const convert = useCallback(async () => {
    setConverting(true)
    try {
      const folder = await window.verdandi.documents.convert(path)
      parent.current.onConverted?.(folder, path)
    } catch (error) {
      setConverting(false)
      setLoadError(`It could not be made into a document folder: ${errorMessage(error)}`)
    }
  }, [path])

  const applyDocument = useCallback((document: TextDocument) => {
    disk.current = { mtimeMs: document.mtimeMs, format: document.format }
    layerNames.current = document.layers ? document.layers.map((layer) => layer.name) : null
    setView(loadView(path, (document.layers ?? [NOTES_LAYER]).map((layer) => layer.name)))
    if (document.folder) void window.verdandi.documents.readViews(path).then(setSavedViews, () => setSavedViews([]))
    version.current = 0
    savedVersion.current = 0
    setExists(document.mtimeMs !== null)
    setLoadError(null)
    setSaveError(null)
    updateState('saved')
    setLoaded((previous) => ({ document, generation: (previous?.generation ?? 0) + 1 }))
    reportStats(document.text, document.format)
    // A one-file Verdandi document becomes a document folder as soon as it opens.
    if (modeOf(document, keepAsFile) === 'convert') void convert()
  }, [reportStats, updateState, keepAsFile, convert, path])

  const load = useCallback(() => window.verdandi.files.read(path).then(
    applyDocument,
    (error: unknown) => {
      setLoadError(errorMessage(error))
      parent.current.onInfo(null)
    },
  ), [path, applyDocument])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    parent.current.onDirtyChange(saveState !== 'saved')
  }, [saveState])

  useEffect(() => () => {
    window.clearTimeout(autosaveTimer.current)
    window.clearTimeout(statsTimer.current)
  }, [])

  // Outside edits: reload silently when there is nothing unsaved, otherwise ask.
  useEffect(() => onDiskChange((paths) => {
    if (!touchesFile(paths, path)) return
    void (async () => {
      if (inFlight.current) await inFlight.current
      const document = await window.verdandi.files.read(path, { allowMissing: true }).catch(() => null)
      const known = disk.current
      if (!document || !known || document.mtimeMs === known.mtimeMs) return // our own save, or no change
      if (state.current === 'saved') applyDocument(document)
      else updateState('conflict')
    })()
  }), [path, applyDocument, updateState])

  const save = useCallback(async (force = false): Promise<boolean> => {
    window.clearTimeout(autosaveTimer.current)
    if (inFlight.current) await inFlight.current
    const handle = editor.current
    const meta = disk.current
    if (!handle || !meta) return state.current === 'saved'
    if (!force && version.current === savedVersion.current) return true
    if (!force && state.current === 'conflict') return false

    const target = version.current
    const text = handle.getText()
    updateState('saving')
    const run = (async () => {
      try {
        const result = await window.verdandi.files.write({
          path, text, format: meta.format, expectedMtimeMs: meta.mtimeMs, force,
        })
        if (!result.ok) {
          updateState('conflict')
          return false
        }
        disk.current = { mtimeMs: result.mtimeMs, format: result.format }
        savedVersion.current = target
        setExists(true)
        setSaveError(null)
        if (result.notice) setNotice(result.notice)
        // A document folder gave new sections ids: the editor takes them unless typing went on meanwhile.
        if (result.text !== undefined && editor.current?.getText() === text) editor.current.sync(result.text)
        const counts = splitWordCounts(text, layerNames.current)
        parent.current.onInfo({ words: counts.output, notesWords: counts.notes, format: result.format })
        if (version.current === target) {
          updateState('saved')
        } else {
          updateState('dirty')
          saveLater.current()
        }
        return true
      } catch (error) {
        setSaveError(errorMessage(error))
        updateState('error')
        return false
      }
    })()
    inFlight.current = run
    try {
      return await run
    } finally {
      inFlight.current = null
    }
  }, [path, updateState])

  // A restore point from before the AI touched anything, in case the writer accepts and regrets it.
  const saveRestorePoint = useCallback((current: string, label: string) => {
    if (current.trim()) {
      void window.verdandi.history.snapshot(path, current, `Before AI: ${label}`).catch(() => {})
    }
  }, [path])

  useImperativeHandle(ref, () => ({
    flush: () => save(),
    // Lines are the file's; the editor starts after the held-back heading.
    revealLine: (line) => editor.current?.revealLine(line),
    currentWord: () => editor.current?.currentWord() ?? null,
    replaceWord: (replacement) => editor.current?.replaceWord(replacement) ?? false,
    getText: () => editor.current?.getText() ?? '',
    getSelection: () => editor.current?.getSelection() ?? '',
    replaceAll: (text) => editor.current?.replaceAll(text),
    currentSection: () => {
      const handle = editor.current
      if (!handle) return null
      const sections = splitSections(handle.getText(), layerNames.current)
      const index = sectionAtLine(sections, handle.cursorLine())
      const section = sections[index]
      return section ? { index, title: section.title, output: section.output, notes: section.notes, layers: section.layers } : null
    },
    propose: (text, label, index) => {
      const handle = editor.current
      if (!handle) return null
      const current = handle.getText()
      const next = replaceSectionOutput(current, index, text, layerNames.current)
      if (next === null) return null
      const count = handle.propose(next, label)
      if (count > 0) saveRestorePoint(current, label)
      return count
    },
    proposeEdit: (oldText, newText, label, snapshot) => {
      const handle = editor.current
      if (!handle) return { error: 'That file is no longer open.' }
      const current = handle.getText()
      let from = 0
      if (oldText) {
        from = current.indexOf(oldText)
        if (from < 0) return { error: 'old_text was not found. Read the file again and copy the passage exactly.' }
        if (current.indexOf(oldText, from + 1) >= 0) return { error: 'old_text appears more than once. Include more of the surrounding text so it is unique.' }
      } else if (current.trim()) {
        return { error: 'old_text is empty, which is only allowed for an empty file.' }
      }
      const count = handle.proposeRange(from, from + oldText.length, newText, label)
      if (count > 0 && snapshot) saveRestorePoint(current, label)
      return { count }
    },
    openHistory: () => setHistoryOpen(true),
    layerNames: () => layerNames.current,
  }), [save, saveRestorePoint])

  useEffect(() => {
    saveLater.current = () => {
      window.clearTimeout(autosaveTimer.current)
      autosaveTimer.current = window.setTimeout(() => void save(), AUTOSAVE_DELAY_MS)
    }
  }, [save])

  const onDocChanged = useCallback(() => {
    version.current += 1
    if (state.current === 'saved' || state.current === 'error') updateState('dirty')
    if (state.current === 'conflict') {
      window.clearTimeout(autosaveTimer.current)
    } else {
      saveLater.current()
    }
    window.clearTimeout(statsTimer.current)
    statsTimer.current = window.setTimeout(() => {
      const format = disk.current?.format
      if (editor.current && format) reportStats(editor.current.getText(), format)
    }, STATS_DELAY_MS)
  }, [reportStats, updateState])

  const reloadFromDisk = () => {
    if (window.confirm('Discard your unsaved changes and load the version on disk?')) void load()
  }

  const mode = loaded ? modeOf(loaded.document, keepAsFile) : null

  const changeView = useCallback((change: (current: DocumentView) => DocumentView) => {
    setView((current) => {
      if (!current) return current
      const next = change(current)
      if (next !== current) storeView(path, next)
      return next
    })
  }, [path])

  const storeSaved = (next: SavedView[]) => {
    setSavedViews(next)
    void window.verdandi.documents.saveViews(path, next).catch((error: unknown) => setNotice(`The views couldn’t be saved: ${errorMessage(error)}`))
  }

  /** Makes one change to the document's layers: saves first, then reloads the document with them. */
  const changeLayers = async (change: LayerChange, label: string) => {
    const handle = editor.current
    if (!handle) return
    if ('remove' in change) {
      const text = handle.getText()
      if (layerHasContent(text, layerNames.current ?? [], change.remove)) {
        if (!window.confirm(`Delete the ${change.remove} layer and everything written in it, in every section? An earlier version is kept in History.`)) return
        void window.verdandi.history.snapshot(path, text, `Before deleting the ${change.remove} layer`).catch(() => {})
      }
    }
    setLayerBusy(true)
    setLayerError(null)
    try {
      if (!(await save())) throw new Error('your edits could not be saved first')
      await window.verdandi.documents.changeLayers(path, change)
      // The view and the saved views follow a renamed or deleted layer.
      const follow = (current: DocumentView): DocumentView => {
        const map = (kind: string): string | null => ('rename' in change && kind === change.rename ? change.to : 'remove' in change && kind === change.remove ? null : kind)
        const shown = current.shown.map(map).filter((kind): kind is string => kind !== null)
        return { ...current, primary: map(current.primary) ?? 'output', shown }
      }
      if ('rename' in change || 'remove' in change) {
        if (view) storeView(path, follow(view))
        if (savedViews.length) storeSaved(savedViews.map((saved) => ({ ...saved, ...follow(saved) })))
      } else if ('add' in change && view) {
        storeView(path, { ...view, shown: view.shown.length ? [...view.shown, change.add.name] : view.shown })
      }
      setNotice(`${label}.`)
      await load()
    } catch (error) {
      setLayerError(`Couldn’t change the layers: ${errorMessage(error)}`)
    } finally {
      setLayerBusy(false)
    }
  }

  /** Changes one section's fields in its file: saves first, then writes them without reloading the editor. */
  const changeFields = async (id: string, change: FieldChange) => {
    setLayerBusy(true)
    setLayerError(null)
    try {
      if (!(await save())) throw new Error('your edits could not be saved first')
      const known = disk.current
      if (!known) return
      const run = window.verdandi.documents.setFields(path, id, change, known.mtimeMs).then((result) => {
        disk.current = { ...known, mtimeMs: result.mtimeMs }
        return result
      })
      // The watcher waits for this, so it finds the document as the editor knows it.
      const settled = run.then(() => true, () => false)
      inFlight.current = settled
      let result: Awaited<typeof run>
      try {
        result = await run
      } finally {
        if (inFlight.current === settled) inFlight.current = null
      }
      setLoaded((previous) => previous && {
        ...previous,
        document: { ...previous.document, mtimeMs: result.mtimeMs, fields: { ...previous.document.fields, [id]: result.fields } },
      })
      setEditingFields(null)
    } catch (error) {
      setLayerError(`Couldn’t save the fields: ${errorMessage(error)}`)
    } finally {
      setLayerBusy(false)
    }
  }

  const fileName = folderName(path)

  // A callout written in Obsidian with a type the document does not declare stays text; offer to make it a layer.
  const newCallout = useMemo(() => {
    const document = loaded?.document
    if (!document?.folder || !document.layers) return null
    return undeclaredCallouts(document.text, document.layers.map((layer) => layer.name)).find((name) => !keptCallouts.includes(name)) ?? null
  }, [loaded, keptCallouts])
  const keepCallout = (name: string) => {
    const next = [...keptCallouts, name]
    setKeptCallouts(next)
    writePref(`keptCallouts:${path.toLowerCase()}`, JSON.stringify(next))
  }

  if (loadError) {
    return (
      <section className="document">
        <div className="document-message">
          <h2>Couldn’t open {fileName}</h2>
          <p>{loadError}</p>
          {onClose && <button type="button" onClick={onClose}>Close</button>}
        </div>
      </section>
    )
  }

  return (
    <section className="document">
      <header className="document-header">
        <div className="document-title" title={path}>
          <span className="document-name">{fileName}</span>
          <span className="document-folder">{folderName(dirname(path))}</span>
          {!exists && <span className="document-new" title="Created when you start typing">new</span>}
        </div>
        <span className={`save-state save-${saveState}`} title={saveError ?? undefined}>
          {exists || saveState !== 'saved' ? SAVE_LABEL[saveState] : ''}
        </span>
        {exists && (
          <button type="button" className="icon-button history-button" onClick={() => setHistoryOpen(true)} title="History: earlier versions of this file" aria-label="History"><History size={14} aria-hidden="true" /></button>
        )}
        {loaded && view && mode !== 'convert' && (
          <ViewControls
            layers={loaded.document.layers ?? [NOTES_LAYER]}
            view={view}
            onView={changeView}
            saved={loaded.document.folder ? savedViews : null}
            activeName={activeView}
            onApply={(saved) => {
              setActiveView(saved.name)
              // The name rides along harmlessly; a view read back from preferences drops it.
              changeView(() => ({ ...saved }))
            }}
            onSaveAs={() => setDialog('save')}
            onUpdate={(name) => storeSaved(savedViews.map((saved) => (saved.name === name ? { ...view, name } : saved)))}
            onDelete={(name) => {
              if (!window.confirm(`Delete the saved view “${name}”?`)) return
              storeSaved(savedViews.filter((saved) => saved.name !== name))
              setActiveView(null)
            }}
            onFilter={() => setDialog('filter')}
            onManageLayers={loaded.document.folder ? () => setDialog('layers') : undefined}
          />
        )}
        {headerActions}
      </header>
      {dialog === 'save' && view && (
        <SaveViewDialog
          taken={savedViews.map((saved) => saved.name)}
          onClose={() => setDialog(null)}
          onSave={(name) => {
            storeSaved([...savedViews.filter((saved) => saved.name !== name), { ...view, name }])
            setActiveView(name)
            setDialog(null)
          }}
        />
      )}
      {dialog === 'filter' && view && (
        <FilterDialog
          fields={loaded?.document.fields ?? {}}
          filter={view.filter}
          onClose={() => setDialog(null)}
          onApply={(filter) => {
            changeView((current) => ({ ...current, filter, page: null }))
            setDialog(null)
          }}
        />
      )}
      {dialog === 'layers' && loaded?.document.layers && (
        <LayersDialog
          layers={loaded.document.layers as Layer[]}
          busy={layerBusy}
          error={layerError}
          onChange={(change, label) => void changeLayers(change, label)}
          onClose={() => {
            setDialog(null)
            setLayerError(null)
          }}
        />
      )}
      {editingFields && loaded?.document.fields && (
        <FieldsDialog
          section={editingFields.title}
          fields={loaded.document.fields[editingFields.id] ?? {}}
          known={fieldValues(Object.values(loaded.document.fields))}
          busy={layerBusy}
          error={layerError}
          onSave={(change) => void changeFields(editingFields.id, change)}
          onClose={() => {
            setEditingFields(null)
            setLayerError(null)
          }}
        />
      )}
      {historyOpen && (
        <HistoryDialog
          path={path}
          current={() => editor.current?.getText() ?? ''}
          onRestore={(text) => {
            setHistoryOpen(false)
            editor.current?.replaceAll(text)
            setNotice('Restored an earlier version. It saves automatically; Ctrl+Z undoes it.')
          }}
          onClose={() => setHistoryOpen(false)}
        />
      )}

      {saveState === 'conflict' && (
        <div className="banner banner-warn" role="alert">
          <span>This file was changed outside Verdandi Writer while you had unsaved edits.</span>
          <button type="button" onClick={reloadFromDisk}>Load disk version</button>
          <button type="button" onClick={() => void save(true)}>Keep mine</button>
        </div>
      )}
      {saveState === 'error' && saveError && (
        <div className="banner banner-error" role="alert">
          <span>Couldn’t save: {saveError}</span>
          <button type="button" onClick={() => void save()}>Retry</button>
        </div>
      )}
      {notice && (
        <div className="banner banner-info" role="status">
          <span>{notice}</span>
          <button type="button" className="icon-button" onClick={() => setNotice(null)} aria-label="Dismiss"><X size={14} aria-hidden="true" /></button>
        </div>
      )}

      {newCallout && mode === 'edit' && (
        <div className="banner banner-info" role="status">
          <span>Some sections have <code>[!{newCallout}]</code> callouts, which this document doesn’t have as a layer, so they show as text.</span>
          <button type="button" disabled={layerBusy}
            onClick={() => void changeLayers({ add: { name: newCallout, kind: 'prose', anchored: false } }, `Added the ${newCallout} layer`)}>
            Make it a layer
          </button>
          <button type="button" onClick={() => keepCallout(newCallout)}>Keep as text</button>
        </div>
      )}
      {mode === 'read' && (
        <div className="banner banner-info" role="status">
          <span>This is an ordinary note, so it opens read-only. Make it a document to edit it in sections.</span>
          <button type="button" disabled={converting} onClick={() => void convert()}>Make this a document</button>
        </div>
      )}

      {loaded && view && mode !== 'convert' ? (
        <SectionGrid
          key={loaded.generation}
          readOnly={mode === 'read'}
          ref={editor}
          path={path}
          title={fileName.replace(/\.[^.]+$/, '')}
          initialText={loaded.document.text}
          live={live}
          focusMode={focusMode}
          layers={loaded.document.layers ?? null}
          view={view}
          onViewChange={changeView}
          fields={loaded.document.fields}
          onManageLayers={loaded.document.folder && mode === 'edit' ? () => setDialog('layers') : undefined}
          onEditFields={loaded.document.folder && mode === 'edit' ? (id, title) => setEditingFields({ id, title }) : undefined}
          onDocChanged={onDocChanged}
          onSave={() => void save()}
          onBlur={() => void save()}
          onFocus={onFocus}
          onSelectWord={onSelectWord}
        />
      ) : (
        <div className="document-message">{mode === 'convert' ? 'Making a folder of sections…' : 'Opening…'}</div>
      )}
    </section>
  )
}
