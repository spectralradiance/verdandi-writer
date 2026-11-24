import { useEffect, useMemo, useState } from 'react'

import { type StylePoint, TRACKED } from '../../shared/analysis'
import type { SectionStyle, StyleReport } from '../../shared/ipc'
import { layerStyleReport } from '../../shared/layerStats'
import { errorMessage } from './target'

/** The measures the overview table shows for every section. */
const OVERVIEW = ['words', 'variety', 'averageSentenceWords', 'passive', 'adverbs', 'dialogue'] as const

const measure = (key: string) => TRACKED.find((item) => item.key === key)!

function format(value: number | undefined, unit = ''): string {
  if (value === undefined) return '–'
  return `${Number.isInteger(value) ? value.toLocaleString() : value.toFixed(1)}${unit}`
}

/** A small line of one measure over the days it was recorded. */
function Sparkline({ points, field }: { points: readonly StylePoint[]; field: string }) {
  const values = points.map((point) => point.values[field as keyof StylePoint['values']]).filter((value): value is number => typeof value === 'number')
  if (values.length < 2) return <span className="lexical-hint">{values.length === 1 ? 'one day so far' : 'no history yet'}</span>
  const width = 120
  const height = 24
  const low = Math.min(...values)
  const span = Math.max(...values) - low || 1
  const step = width / (values.length - 1)
  const line = values.map((value, index) => `${(index * step).toFixed(1)},${(height - 2 - ((value - low) / span) * (height - 4)).toFixed(1)}`).join(' ')
  return (
    <svg className="style-spark" viewBox={`0 0 ${width} ${height}`} role="img"
      aria-label={`${values.length} days, from ${format(values[0])} to ${format(values.at(-1))}`}>
      <title>{points.map((point) => `${point.day}: ${format(point.values[field as keyof StylePoint['values']])}`).join('\n')}</title>
      <polyline points={line} />
      <circle cx={width} cy={line.split(' ').at(-1)!.split(',')[1]} r="2" />
    </svg>
  )
}

function Change({ section, field }: { section: SectionStyle; field: string }) {
  const first = section.history[0]?.values[field as keyof StylePoint['values']]
  const now = section.metrics[field as keyof SectionStyle['metrics']] as number
  if (first === undefined || section.history.length < 2) return null
  const delta = now - first
  if (Math.abs(delta) < 0.05) return <span className="style-change">no change</span>
  return <span className="style-change">{delta > 0 ? '+' : '−'}{format(Math.abs(delta))} since {section.history[0].day}</span>
}

function Detail({ section }: { section: SectionStyle }) {
  if (!section.measured) {
    return <p className="lexical-hint">“{section.title}” is too short to measure yet: the numbers mean little under twenty words.</p>
  }
  return (
    <>
      <table className="settings-table style-detail">
        <thead><tr><th>Measure</th><th>Now</th><th>Over time</th><th /></tr></thead>
        <tbody>
          {TRACKED.map(({ key, label, unit, hint }) => (
            <tr key={key}>
              <td title={hint}>{label}</td>
              <td>{format(section.metrics[key] as number, unit)}</td>
              <td><Sparkline points={section.history} field={key} /></td>
              <td><Change section={section} field={key} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      {section.metrics.repeated.length > 0 && (
        <p className="lexical-hint">Most repeated: {section.metrics.repeated.map((item) => `${item.word} ×${item.count}`).join(', ')}</p>
      )}
    </>
  )
}

interface StylePanelProps {
  path: string
  /** The layer measured: `output` (the text, with its history) or another, measured now. */
  layer: string
  text: string
  layerNames: string[] | null
  onOpenSection: (line: number) => void
}

/**
 * Vocabulary and grammar per section: an overview of every section, and one
 * section's measures. For the text, with how each has changed since it was first
 * recorded (a point is recorded each day a save changes the section's text);
 * another layer is measured as it is now.
 */
export function StylePanel({ path, layer, text, layerNames, onOpenSection }: StylePanelProps) {
  const [saved, setSaved] = useState<StyleReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string>('*')
  const isText = layer === 'output'

  useEffect(() => {
    if (isText) window.verdandi.stats.style(path).then(setSaved, (reason: unknown) => setError(errorMessage(reason)))
  }, [path, isText])
  const measuredNow = useMemo(() => (isText ? null : layerStyleReport(text, layerNames, layer)), [isText, text, layerNames, layer])
  const report = isText ? saved : measuredNow

  if (error) return <p className="lexical-message status-error">{error}</p>
  if (!report) return <p className="lexical-hint">Measuring…</p>
  const all = [report.document, ...report.sections]
  const current = all.find((section) => section.key === selected) ?? report.document

  return (
    <div className="settings-section">
      <table className="settings-table stats-table style-overview">
        <thead>
          <tr>
            <th>Section</th>
            {OVERVIEW.map((key) => <th key={key} title={measure(key).hint}>{measure(key).label}</th>)}
          </tr>
        </thead>
        <tbody>
          {all.map((section) => (
            <tr key={section.key} className={section.key === current.key ? 'selected' : undefined}>
              <td>
                <button type="button" className="link-button" onClick={() => setSelected(section.key)} aria-pressed={section.key === current.key}>
                  {section.title}
                </button>
              </td>
              {OVERVIEW.map((key) => (
                <td key={key}>{section.measured || key === 'words' ? format(section.metrics[key], key === 'words' ? '' : measure(key).unit) : '–'}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      <h3 className="stats-heading">
        {current.title}
        {current !== report.document && (
          <button type="button" className="link-button style-open" onClick={() => onOpenSection(current.line)}>Go to section</button>
        )}
      </h3>
      <Detail section={current} />
      <p className="lexical-hint">
        {isText
          ? 'Measured on this computer from the text alone (other layers are left out). A point is recorded each day a save changes a section’s text.'
          : 'Measured on this computer from this layer as it is now; its history isn’t kept, only the text’s.'}
        {' '}Passive voice and adverbs are estimates from word shapes.
      </p>
    </div>
  )
}
