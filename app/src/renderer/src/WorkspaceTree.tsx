import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react'

import { type SectionSummary, summarizeSections } from '../../shared/document'
import { layerNamesOf } from '../../shared/layers'
import { folderName } from '../../shared/format'
import type { FolderListing } from '../../shared/ipc'
import { dirname, joinPath, samePath } from '../../shared/paths'
import { onDiskChange, touchesFile, touchesFolder } from './changes'
import { FilesIcon, OutlineIcon, PaneIcon, SearchIcon } from './icons'
import { ContextMenu } from './menu'
import { errorMessage, type OpenTarget } from './target'
import { ChevronDown, ChevronRight, FilePlus, FolderPlus, X } from 'lucide-react'

export interface TreeActions {
  target: OpenTarget | null
  open: (target: OpenTarget) => void
  /** Opens a file and scrolls to a line. */
  openAt: (path: string, line: number) => void
  /** Moves the `from`th section of a file to the place of the `to`th. */
  moveSection: (file: string, from: number, to: number) => Promise<void>
  /** Renames a folder on disk, keeping whatever is open inside it open. */
  renameFolder: (folder: string, name: string) => Promise<void>
  /** Renames a file on disk, keeping it open if it is. */
  renameFile: (file: string, name: string) => Promise<void>
  /** Moves a file to the Recycle Bin, offering Undo afterwards. */
  deleteFile: (file: string) => Promise<void>
  /** Moves a folder and its contents to the Recycle Bin, after asking. */
  deleteFolder: (folder: string) => Promise<void>
  /** Shows a file or folder in the system file manager. */
  reveal: (path: string) => void
}

/** The system file manager's name, for menu labels. */
const REVEAL_LABEL = /Windows/i.test(navigator.userAgent)
  ? 'Show in File Explorer'
  : /Mac/i.test(navigator.userAgent) ? 'Reveal in Finder' : 'Open in file manager'

const TreeContext = createContext<TreeActions | null>(null)

function useTree(): TreeActions {
  const context = useContext(TreeContext)
  if (!context) throw new Error('WorkspaceTree context missing')
  return context
}

const indent = (depth: number, extra = 0) => ({ paddingLeft: `${8 + depth * 14 + extra}px` })

/** A document's name in the tree: the file name without a .md extension. */
const documentName = (file: string) => file.replace(/\.md$/i, '')

function NameInput({ initial, placeholder, depth, onSubmit, onCancel }: {
  initial: string
  placeholder: string
  depth: number
  onSubmit: (value: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  return (
    <li className="tree-input-row" style={indent(depth, 18)}>
      <input
        className="tree-input"
        autoFocus
        value={value}
        placeholder={placeholder}
        onChange={(event) => setValue(event.target.value)}
        onFocus={(event) => event.target.select()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && value.trim()) onSubmit(value.trim())
          if (event.key === 'Escape') onCancel()
        }}
        onBlur={onCancel}
      />
    </li>
  )
}

/** A file's `#` sections, read from disk and kept current while it is expanded. */
function useFileSections(path: string, enabled: boolean): SectionSummary[] {
  const [sections, setSections] = useState<SectionSummary[]>([])
  const load = useCallback(() => window.verdandi.files.read(path, { allowMissing: true }).then(
    (document) => setSections(document.mtimeMs === null ? [] : summarizeSections(document.text, layerNamesOf(document)).filter((section) => section.title !== null)),
    () => setSections([]),
  ), [path])
  useEffect(() => {
    if (enabled) void load()
  }, [enabled, load])
  useEffect(() => {
    if (!enabled) return
    return onDiskChange((paths) => {
      if (touchesFile(paths, path)) void load()
    })
  }, [enabled, path, load])
  return sections
}

function FileRow({ folder, name, depth, onRemoveRoot }: {
  folder: string
  name: string
  depth: number
  /** A workspace folder that is itself a document: removed from the workspace, never deleted from here. */
  onRemoveRoot?: () => void
}) {
  const tree = useTree()
  const [renaming, setRenaming] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [drag, setDrag] = useState<{ from: number | null; over: number | null }>({ from: null, over: null })
  const path = joinPath(folder, name)
  const selected = tree.target !== null && samePath(tree.target.path, path)
  const sections = useFileSections(path, expanded)

  if (renaming) {
    return (
      <NameInput
        initial={documentName(name)}
        placeholder="Document name"
        depth={depth}
        onCancel={() => setRenaming(false)}
        onSubmit={(next) => {
          setRenaming(false)
          if (next !== documentName(name)) void tree.renameFile(path, next)
        }}
      />
    )
  }
  return (
    <li>
      <ContextMenu items={[
        { label: 'Rename', onClick: () => setRenaming(true) },
        { label: REVEAL_LABEL, onClick: () => tree.reveal(path) },
        'separator',
        onRemoveRoot
          ? { label: 'Remove from workspace', onClick: onRemoveRoot, title: 'Its files are not touched' }
          : { label: 'Delete', onClick: () => void tree.deleteFile(path) },
      ]}>
        <div className={`tree-row-wrap${onRemoveRoot ? ' tree-root' : ''}`}>
          <button
            type="button"
            className={`tree-row tree-file${selected ? ' selected' : ''}`}
            style={indent(depth)}
            onClick={() => tree.open({ path })}
            onDoubleClick={() => setRenaming(true)}
            aria-expanded={expanded}
            title={path}
          >
            <span
              className="tree-chevron"
              role="button"
              aria-label={expanded ? 'Hide sections' : 'Show sections'}
              title={expanded ? 'Hide sections' : 'Show sections'}
              onClick={(event) => {
                event.stopPropagation()
                setExpanded(!expanded)
              }}
              onDoubleClick={(event) => event.stopPropagation()}
            >
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </span>
            <span className="tree-label">{documentName(name)}</span>
          </button>
          {onRemoveRoot && (
            <span className="tree-actions">
              <button type="button" className="icon-button" title="Remove from workspace (files are not touched)" onClick={onRemoveRoot}><X size={14} aria-hidden="true" /></button>
            </span>
          )}
        </div>
      </ContextMenu>
      {expanded && (
        <ul className="tree">
          {sections.length === 0 && <li className="tree-note" style={indent(depth + 1, 18)}>No sections yet</li>}
          {sections.map((section, index) => (
            <li
              key={`${section.line}:${section.title}`}
              className={`${drag.from === index ? 'dragging' : ''}${drag.from !== null && drag.over === index && drag.from !== index ? ' drop-target' : ''}`}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData('text/plain', section.title ?? '')
                setDrag({ from: index, over: null })
              }}
              onDragOver={(event) => {
                if (drag.from === null) return
                event.preventDefault()
                if (drag.over !== index) setDrag({ from: drag.from, over: index })
              }}
              onDrop={(event) => {
                event.preventDefault()
                if (drag.from !== null && drag.from !== index) void tree.moveSection(path, drag.from, index)
                setDrag({ from: null, over: null })
              }}
              onDragEnd={() => setDrag({ from: null, over: null })}
            >
              <button
                type="button"
                className="tree-row tree-section"
                style={indent(depth + 1, 18 + (section.level - Math.min(...sections.map((item) => item.level))) * 12)}
                onClick={() => tree.openAt(path, section.line)}
                title={section.title ?? undefined}
              >
                <span className="tree-label">{section.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

type Editing = 'folder' | 'document' | null

function FolderNode({ path, depth, initiallyOpen = false, onRemoveRoot }: {
  path: string
  depth: number
  initiallyOpen?: boolean
  onRemoveRoot?: () => void
}) {
  const tree = useTree()
  const [open, setOpen] = useState(initiallyOpen)
  const [listing, setListing] = useState<FolderListing | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Editing>(null)
  const [renaming, setRenaming] = useState(false)

  const load = useCallback(() => window.verdandi.folders.read(path).then(
    (next) => {
      setListing(next)
      setError(null)
    },
    (reason: unknown) => setError(errorMessage(reason)),
  ), [path])

  // A workspace folder is read at once, to know whether it is itself a document.
  const watching = open || depth === 0
  useEffect(() => {
    if (watching) void load()
  }, [watching, load])

  useEffect(() => {
    if (!watching) return
    return onDiskChange((paths) => {
      if (touchesFolder(paths, path)) void load()
    })
  }, [watching, path, load])

  const startEditing = (kind: Editing) => {
    setOpen(true)
    setEditing(kind)
  }
  // A new document is a document folder: its main file, and a file for each other layer once it has content.
  const createDocument = (name: string) => {
    setEditing(null)
    window.verdandi.documents.create(path, name.replace(/\.(md|markdown|txt)$/i, '')).then(
      (folder) => tree.open({ path: folder }),
      (reason: unknown) => window.alert(errorMessage(reason)),
    )
  }
  const createFolder = (name: string) => {
    setEditing(null)
    window.verdandi.folders.create(path, name).then(() => load(), (reason: unknown) => window.alert(errorMessage(reason)))
  }

  const empty = listing && listing.folders.length === 0 && listing.files.length === 0
  const title = folderName(path)
  // A workspace folder that is a document lists as that document, not as the files that make it up.
  if (depth === 0 && listing?.document) {
    return <FileRow folder={dirname(path)} name={title} depth={0} onRemoveRoot={onRemoveRoot} />
  }

  return (
    <li>
      {renaming ? (
        <ul className="tree">
          <NameInput
            initial={title}
            placeholder="Folder name"
            depth={depth - 1}
            onCancel={() => setRenaming(false)}
            onSubmit={(name) => {
              setRenaming(false)
              if (name !== title) void tree.renameFolder(path, name)
            }}
          />
        </ul>
      ) : (
      <ContextMenu items={[
        { label: 'New document', onClick: () => startEditing('document') },
        { label: 'New folder', onClick: () => startEditing('folder') },
        'separator',
        { label: 'Rename', onClick: () => setRenaming(true) },
        { label: REVEAL_LABEL, onClick: () => tree.reveal(path) },
        'separator',
        // A workspace folder is removed from the workspace, never deleted from here.
        onRemoveRoot
          ? { label: 'Remove from workspace', onClick: onRemoveRoot, title: 'Its files are not touched' }
          : { label: 'Delete', onClick: () => void tree.deleteFolder(path), title: 'Moves the folder and everything in it to the Recycle Bin' },
      ]}>
      <div className={`tree-row-wrap${depth === 0 ? ' tree-root' : ''}`}>
        <button
          type="button"
          className="tree-row tree-dir"
          style={indent(depth)}
          onClick={() => setOpen(!open)}
          onDoubleClick={() => setRenaming(true)}
          aria-expanded={open}
          title={path}
        >
          <span className="tree-chevron" aria-hidden="true">
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
          <span className="tree-label">{title}</span>
        </button>
        <span className="tree-actions">
          <button type="button" className="icon-button" title="New document" onClick={() => startEditing('document')}><FilePlus size={14} aria-hidden="true" /></button>
          <button type="button" className="icon-button" title="New folder" onClick={() => startEditing('folder')}><FolderPlus size={14} aria-hidden="true" /></button>
          {onRemoveRoot && (
            <button type="button" className="icon-button" title="Remove from workspace (files are not touched)" onClick={onRemoveRoot}><X size={14} aria-hidden="true" /></button>
          )}
        </span>
      </div>
      </ContextMenu>
      )}
      {open && (
        <ul className="tree">
          {error && <li className="tree-note" style={indent(depth, 18)}>{error}</li>}
          {editing === 'folder' && (
            <NameInput initial="" placeholder="Folder name" depth={depth + 1} onSubmit={createFolder} onCancel={() => setEditing(null)} />
          )}
          {listing?.folders.map((name) => (
            <FolderNode key={name} path={joinPath(path, name)} depth={depth + 1} />
          ))}
          {listing?.files.map((name) => (
            <FileRow key={name} folder={path} name={name} depth={depth + 1} />
          ))}
          {editing === 'document' && (
            <NameInput initial="" placeholder="Document name" depth={depth + 1} onSubmit={createDocument} onCancel={() => setEditing(null)} />
          )}
          {empty && !editing && <li className="tree-note" style={indent(depth + 1, 18)}>Empty folder</li>}
        </ul>
      )}
    </li>
  )
}

export type SidebarTab = 'files' | 'outline' | 'search'

interface WorkspaceTreeProps extends TreeActions {
  roots: string[]
  onAddRoot: () => void
  onRemoveRoot: (path: string) => void
  tab: SidebarTab
  onTab: (tab: SidebarTab) => void
  /** Rendered in place of the tree on the Outline and Search tabs. */
  outline: ReactNode
  search: ReactNode
  /** Collapsed to a strip of tab icons. */
  collapsed: boolean
  onToggle: () => void
  /** The drag handle on the sidebar's right edge. */
  resizer: ReactNode
}

const SIDEBAR_TABS: { id: SidebarTab; label: string; icon: () => ReactNode; title: string }[] = [
  { id: 'files', label: 'Files', icon: FilesIcon, title: 'Files' },
  { id: 'outline', label: 'Outline', icon: OutlineIcon, title: 'Every section and heading in the open document' },
  { id: 'search', label: 'Search', icon: SearchIcon, title: 'Search all folders (Ctrl+Shift+F)' },
]

export function WorkspaceTree({
  roots, onAddRoot, onRemoveRoot, tab, onTab, outline, search, collapsed, onToggle, resizer, ...actions
}: WorkspaceTreeProps) {
  if (collapsed) {
    return (
      <nav className="side-rail left-rail" aria-label="Sidebar">
        <button type="button" className="side-rail-tab" onClick={onToggle} title="Show sidebar (Ctrl+\)" aria-label="Show sidebar">
          <PaneIcon side="left" open={false} />
        </button>
        {SIDEBAR_TABS.map((item) => (
          <button key={item.id} type="button" className="side-rail-tab" title={item.title} aria-label={item.label}
            onClick={() => {
              onTab(item.id)
              onToggle()
            }}>
            <item.icon />
          </button>
        ))}
      </nav>
    )
  }
  return (
    <TreeContext.Provider value={actions}>
      <aside className="sidebar">
        <header className="sidebar-header">
          <nav className="sidebar-tabs" role="tablist">
            {SIDEBAR_TABS.map((item) => (
              <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} onClick={() => onTab(item.id)} title={item.title}>{item.label}</button>
            ))}
          </nav>
          <button type="button" className="icon-button" onClick={onAddRoot} title="Add folder…" aria-label="Add folder"><FolderPlus size={14} aria-hidden="true" /></button>
          <button type="button" className="icon-button" onClick={onToggle} title="Hide sidebar (Ctrl+\)" aria-label="Hide sidebar">
            <PaneIcon side="left" open />
          </button>
        </header>
        {tab === 'search' ? search : tab === 'outline' ? outline : roots.length === 0 ? (
          <>
            <p className="sidebar-empty">No folders yet. Folders are edited in place; nothing is copied.</p>
            <button type="button" className="add-folder" onClick={onAddRoot}>Add folder…</button>
          </>
        ) : (
          <ul className="tree tree-top">
            {roots.map((root) => (
              <FolderNode
                key={root}
                path={root}
                depth={0}
                initiallyOpen={roots.length === 1}
                onRemoveRoot={() => onRemoveRoot(root)}
              />
            ))}
          </ul>
        )}
        {resizer}
      </aside>
    </TreeContext.Provider>
  )
}
