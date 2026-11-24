import { layerLabel } from '../../shared/layers'
import { encodingLabel, lineEndingLabel } from '../../shared/text'
import type { DocumentInfo } from './DocumentPane'
import { GearIcon, PaneIcon } from './icons'

interface StatusBarProps {
  documentInfo: DocumentInfo | null
  /** Net words written today across all files. */
  todayWords?: number | null
  /** Pane toggles; left out in focus mode. */
  panes: { left: boolean; right: boolean; onLeft: () => void; onRight: () => void } | null
  onSettings: () => void
}

/** How long `words` take to read, at 238 words a minute: `4 min`, `2 h 5 min`. */
export function readingTime(words: number): string {
  const minutes = Math.max(1, Math.round(words / 238))
  if (minutes < 60) return `${minutes} min read`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours} h ${rest} min read` : `${hours} h read`
}

export function StatusBar({ documentInfo, todayWords, panes, onSettings }: StatusBarProps) {
  return (
    <footer className="statusbar">
      {panes && (
        <button type="button" className="status-icon" onClick={panes.onLeft} aria-pressed={panes.left}
          title={`${panes.left ? 'Hide' : 'Show'} sidebar (Ctrl+\\)`} aria-label="Sidebar">
          <PaneIcon side="left" open={panes.left} />
        </button>
      )}
      <button type="button" className="status-icon" onClick={onSettings} title="Settings: appearance and export (Ctrl+,)" aria-label="Settings">
        <GearIcon />
      </button>
      {todayWords !== undefined && todayWords !== null && todayWords !== 0 && (
        <span className="status-item status-today" title="Net words written today, all files">
          Today {todayWords > 0 ? '+' : ''}{todayWords.toLocaleString()}
        </span>
      )}
      {documentInfo && (
        <span className="status-document">
          <span className="status-layer" title="The focus layer: the one each section starts with">{layerLabel(documentInfo.layer)}</span>
          <span title={`${documentInfo.characters.toLocaleString()} characters`}>
            {documentInfo.words.toLocaleString()} {documentInfo.words === 1 ? 'word' : 'words'}
          </span>
          {documentInfo.words > 0 && <span title="Reading time, at 238 words a minute">{readingTime(documentInfo.words)}</span>}
          {documentInfo.sections > 0 && (
            <span title={`Sections with something in the ${layerLabel(documentInfo.layer).toLowerCase()}`}>
              {documentInfo.filled.toLocaleString()} of {documentInfo.sections.toLocaleString()} sections
            </span>
          )}
          <span title="File encoding">{encodingLabel(documentInfo.format.encoding)}</span>
          <span title="Line endings">
            {lineEndingLabel(documentInfo.format.eol)}{documentInfo.format.mixedEol ? ' (mixed)' : ''}
          </span>
        </span>
      )}
      {panes && (
        <button type="button" className={`status-icon${documentInfo ? '' : ' status-end'}`} onClick={panes.onRight} aria-pressed={panes.right}
          title={`${panes.right ? 'Hide' : 'Show'} Words and AI panel`} aria-label="Side panel">
          <PaneIcon side="right" open={panes.right} />
        </button>
      )}
    </footer>
  )
}
