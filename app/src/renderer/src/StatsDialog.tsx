import { X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import type { DailyWords, DocumentStats } from '../../shared/ipc'
import { formatMinutes, layerOverview, layerTable } from '../../shared/layerStats'
import { kindLabel } from './editor/SectionGrid'
import { Modal } from './Modal'
import { StylePanel } from './StylePanel'
import { errorMessage } from './target'

interface StatsDialogProps {
  /** The document file. */
  path: string
  title: string
  /** The document's text as it is now, with its layers' blocks. */
  text: string
  /** The document's layer names for the classifier (null for a one-file document's notes). */
  layerNames: string[] | null
  /** The layer shown first: the document's focus layer. */
  focusLayer: string
  /** Jumps to a section's heading (1-based line). */
  onOpenSection: (line: number) => void
  onClose: () => void
}

type Tab = 'overview' | 'style' | 'layers'

function DailyChart({ days }: { days: DailyWords[] }) {
  const values = days.map((day) => day.notes + day.output)
  const peak = Math.max(1, ...values.map(Math.abs))
  const width = 16
  const height = 64
  return (
    <svg className="daily-chart" viewBox={`0 0 ${days.length * width} ${height + 16}`} role="img"
      aria-label="Net words written per day for the last two weeks">
      <line x1="0" x2={days.length * width} y1={height / 2} y2={height / 2} className="daily-axis" />
      {days.map((day, index) => {
        const value = day.notes + day.output
        const bar = (Math.abs(value) / peak) * (height / 2 - 2)
        return (
          <g key={day.day}>
            <title>{`${day.day}: ${value >= 0 ? '+' : ''}${value} words (output ${day.output}, notes ${day.notes})`}</title>
            <rect x={index * width + 3} width={width - 6} y={value >= 0 ? height / 2 - bar : height / 2} height={Math.max(bar, value ? 1 : 0)}
              className={value >= 0 ? 'daily-up' : 'daily-down'} />
            {(index === 0 || index === days.length - 1) && (
              <text x={index === 0 ? 0 : days.length * width} y={height + 12} className="daily-label"
                textAnchor={index === 0 ? 'start' : 'end'}>{index === days.length - 1 ? 'today' : day.day.slice(5)}</text>
            )}
          </g>
        )
      })}
    </svg>
  )
}

/**
 * Statistics for the open document, one layer at a time: first its focus layer, and
 * any other from the picker. Counts and vocabulary are worked out here from the
 * text; the goal, the daily words and the text's style history come from the app.
 */
export function StatsDialog({ path, title, text, layerNames, focusLayer, onOpenSection, onClose }: StatsDialogProps) {
  const [stats, setStats] = useState<DocumentStats | null>(null)
  const [days, setDays] = useState<DailyWords[]>([])
  const [goal, setGoal] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('overview')
  const [layer, setLayer] = useState(focusLayer)

  useEffect(() => {
    window.verdandi.stats.document(path).then((result) => {
      setStats(result)
      setGoal(result.goal ? String(result.goal) : '')
    }, (reason: unknown) => setError(errorMessage(reason)))
    void window.verdandi.stats.daily(14).then(setDays)
  }, [path])

  // The text and its layers, then the layers with anything in them (and the one chosen).
  const layers = useMemo(() => ['output', ...(layerNames ?? ['notes'])], [layerNames])
  const table = useMemo(() => layerTable(text, layerNames, layers), [text, layerNames, layers])
  const choices = layers.filter((name) => name === layer || name === focusLayer || table.some((row) => row.words[name] > 0))
  const overview = useMemo(() => layerOverview(text, layerNames, layer), [text, layerNames, layer])

  const saveGoal = () => {
    const words = Number(goal.replace(/[^\d]/g, ''))
    window.verdandi.stats.setGoal(path, words > 0 ? words : null).then(setStats, (reason: unknown) => setError(errorMessage(reason)))
  }

  const isText = layer === 'output'
  const progress = isText && stats?.goal ? Math.min(1, overview.words / stats.goal) : null
  const week = days.slice(-7).reduce((sum, day) => sum + day.notes + day.output, 0)
  const today = days.at(-1)
  const largest = Math.max(1, ...overview.rows.map((row) => row.words))
  const label = kindLabel(layer)

  return (
    <Modal label={`Statistics for ${title}`} className="stats-dialog" onClose={onClose}>
      <header className="modal-header">
        <h2>Statistics · {title}</h2>
        <label className="stats-layer-picker">
          Layer
          <select value={layer} onChange={(event) => setLayer(event.target.value)}>
            {choices.map((name) => <option key={name} value={name}>{kindLabel(name)}{name === focusLayer ? ' (focus)' : ''}</option>)}
          </select>
        </label>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={14} aria-hidden="true" /></button>
      </header>
      <nav className="lexical-tabs" role="tablist">
        {(['overview', 'style', 'layers'] as const).map((id) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
            {{ overview: label, style: 'Vocabulary and grammar', layers: 'All layers' }[id]}
          </button>
        ))}
      </nav>
      <div className="settings-body">
        {tab === 'style' && <StylePanel key={layer} path={path} layer={layer} text={text} layerNames={layerNames} onOpenSection={onOpenSection} />}

        {tab === 'overview' && (
          <div className="settings-section">
            <div className="stats-summary">
              <div><strong>{overview.words.toLocaleString()}</strong><span>words</span></div>
              <div><strong>{overview.characters.toLocaleString()}</strong><span>characters</span></div>
              <div><strong>{overview.words ? formatMinutes(overview.readingMinutes) : '–'}</strong><span>to read</span></div>
              <div><strong>{overview.words ? formatMinutes(overview.speakingMinutes) : '–'}</strong><span>to read aloud</span></div>
              <div><strong>{overview.filled}/{overview.sections}</strong><span>sections with {label.toLowerCase()}</span></div>
              <div><strong>{overview.filled ? Math.round(overview.words / overview.filled).toLocaleString() : '–'}</strong><span>words a section</span></div>
              <div><strong>{overview.paragraphs.toLocaleString()}</strong><span>paragraphs</span></div>
            </div>
            {overview.longest && (
              <p className="lexical-hint">
                Longest: <button type="button" className="link-button" onClick={() => onOpenSection(overview.longest!.line)}>{overview.longest.title}</button>
                {' '}({overview.longest.words.toLocaleString()} words, {Math.round((overview.longest.words / Math.max(1, overview.words)) * 100)}% of the {label.toLowerCase()})
              </p>
            )}

            {isText && (
              <div className="stats-goal">
                <label>
                  Goal
                  <input value={goal} inputMode="numeric" placeholder="e.g. 5000" onChange={(event) => setGoal(event.target.value)}
                    onBlur={saveGoal} onKeyDown={(event) => { if (event.key === 'Enter') saveGoal() }} />
                  words
                </label>
                {progress !== null && (
                  <div className="goal-bar" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
                    <div style={{ width: `${progress * 100}%` }} />
                    <span>{Math.round(progress * 100)}% · {Math.max(0, stats!.goal! - overview.words).toLocaleString()} to go</span>
                  </div>
                )}
              </div>
            )}
            {error && <p className="lexical-message status-error">{error}</p>}

            <table className="settings-table stats-table">
              <thead>
                <tr><th>Section</th><th>Words</th><th className="stats-bar-head">Share</th><th>Paragraphs</th></tr>
              </thead>
              <tbody>
                {overview.rows.map((row) => (
                  <tr key={`${row.line}:${row.title}`}>
                    <td>
                      {row.title === null
                        ? <span className="lexical-hint">Before the first section</span>
                        : <button type="button" className="link-button" onClick={() => onOpenSection(row.line)}>{row.title}</button>}
                    </td>
                    <td>{row.words ? row.words.toLocaleString() : <span className="lexical-hint">none yet</span>}</td>
                    <td className="stats-bar-cell" title={`${Math.round((row.words / Math.max(1, overview.words)) * 1000) / 10}% of the ${label.toLowerCase()}`}>
                      <span className="stats-bar" style={{ width: `${(row.words / largest) * 100}%` }} />
                    </td>
                    <td>{row.paragraphs || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {stats?.modified && <p className="lexical-hint">Last changed {new Date(stats.modified).toLocaleString()}</p>}

            <h3 className="stats-heading">Words written, last two weeks <span className="lexical-hint">(all documents, all layers)</span></h3>
            <DailyChart days={days} />
            <p className="lexical-hint">
              Today {today ? `${today.notes + today.output >= 0 ? '+' : ''}${(today.notes + today.output).toLocaleString()}` : '0'} ·
              {' '}last 7 days {week >= 0 ? '+' : ''}{week.toLocaleString()} (net: cuts count as negative)
            </p>
          </div>
        )}

        {tab === 'layers' && (
          <div className="settings-section">
            <table className="settings-table stats-table">
              <thead>
                <tr>
                  <th>Section</th>
                  {choices.map((name) => <th key={name} className={name === layer ? 'stats-chosen' : undefined}>{kindLabel(name)}</th>)}
                </tr>
              </thead>
              <tbody>
                {table.map((row) => (
                  <tr key={`${row.line}:${row.title}`}>
                    <td><button type="button" className="link-button" onClick={() => onOpenSection(row.line)}>{row.title}</button></td>
                    {choices.map((name) => (
                      <td key={name} className={name === layer ? 'stats-chosen' : undefined}>{row.words[name] ? row.words[name].toLocaleString() : ''}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th>Total</th>
                  {choices.map((name) => (
                    <th key={name} className={name === layer ? 'stats-chosen' : undefined}>{table.reduce((sum, row) => sum + row.words[name], 0).toLocaleString()}</th>
                  ))}
                </tr>
              </tfoot>
            </table>
            <p className="lexical-hint">Words in each layer, section by section: the layers with nothing in them are left out.</p>
          </div>
        )}
      </div>
    </Modal>
  )
}
