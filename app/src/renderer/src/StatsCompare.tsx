import { useMemo, useState } from 'react'

import { compareLayers, compareSentences } from '../../shared/compareLayers'
import { splitSections } from '../../shared/document'
import { layerText } from '../../shared/layerStats'
import { kindLabel } from './editor/SectionGrid'

interface StatsCompareProps {
  text: string
  layerNames: string[] | null
  /** The layer looked at (the newer one, as a rule): what was added is what it has. */
  layer: string
  /** The layers it can be compared with. */
  others: readonly string[]
  onOpenSection: (line: number) => void
}

type Order = 'document' | 'changed'

const DRAFT_LIKE = /draft|version|revision|edit|old|previous|\bv\d/i

const signed = (value: number) => (value > 0 ? `+${value.toLocaleString()}` : value < 0 ? `−${Math.abs(value).toLocaleString()}` : '0')

/**
 * One layer against another, section by section: words added, cut and kept, how
 * alike each section is, and, for the section chosen, its sentences side by side.
 */
export function StatsCompare({ text, layerNames, layer, others, onOpenSection }: StatsCompareProps) {
  // Another draft first, if there is one: a layer named like a draft or version, else one named like this one.
  const [other, setOther] = useState(() => others.find((name) => DRAFT_LIKE.test(name))
    ?? others.find((name) => name.startsWith(layer.split(/[\s-]/)[0])) ?? others[0] ?? '')
  const [order, setOrder] = useState<Order>('document')
  const [open, setOpen] = useState<string | null>(null)
  const result = useMemo(() => (other ? compareLayers(text, layerNames, other, layer) : null), [text, layerNames, other, layer])
  const detail = useMemo(() => {
    if (!open) return null
    const section = splitSections(text, layerNames).find((candidate) => `${candidate.line}:${candidate.title}` === open)
    return section ? compareSentences(layerText(section, other, layerNames), layerText(section, layer, layerNames)) : null
  }, [open, text, layerNames, other, layer])

  if (others.length === 0) return <p className="lexical-hint">This document has no other layer to compare with.</p>
  const rows = result ? [...result.sections] : []
  if (order === 'changed') rows.sort((a, b) => (b.added + b.removed) - (a.added + a.removed))
  const peak = Math.max(1, ...rows.map((row) => Math.max(row.added, row.removed)))

  return (
    <div className="settings-section">
      <div className="stats-compare-head">
        <span>{kindLabel(layer)} against</span>
        <select value={other} onChange={(event) => { setOther(event.target.value); setOpen(null) }} aria-label="Layer to compare with">
          {others.map((name) => <option key={name} value={name}>{kindLabel(name)}</option>)}
        </select>
        <span className="stats-compare-order">
          Order
          <select value={order} onChange={(event) => setOrder(event.target.value as Order)} aria-label="Order of the sections">
            <option value="document">as in the document</option>
            <option value="changed">most changed first</option>
          </select>
        </span>
      </div>
      {result && (
        <>
          <div className="stats-summary">
            <div><strong>{signed(result.after - result.before)}</strong><span>words ({result.before.toLocaleString()} → {result.after.toLocaleString()})</span></div>
            <div><strong className="compare-added">+{result.added.toLocaleString()}</strong><span>words added</span></div>
            <div><strong className="compare-removed">−{result.removed.toLocaleString()}</strong><span>words cut</span></div>
            <div><strong>{result.before + result.after ? Math.round((result.kept * 200) / (result.before + result.after)) : 100}%</strong><span>alike</span></div>
            <div><strong>{result.changedSections}/{result.sections.length}</strong><span>sections changed</span></div>
            {result.newSections > 0 && <div><strong>{result.newSections}</strong><span>new in {kindLabel(layer).toLowerCase()}</span></div>}
            {result.emptiedSections > 0 && <div><strong>{result.emptiedSections}</strong><span>empty in {kindLabel(layer).toLowerCase()}</span></div>}
          </div>
          <p className="lexical-hint">
            Compared sentence by sentence: a sentence changed at all counts as cut from {kindLabel(other)} and added in {kindLabel(layer)}. Choose a section to see its sentences.
          </p>
          <table className="settings-table stats-table compare-table">
            <thead>
              <tr>
                <th>Section</th><th>{kindLabel(other)}</th><th>{kindLabel(layer)}</th><th>Added</th><th>Cut</th>
                <th className="stats-bar-head">Change</th><th>Alike</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const key = `${row.line}:${row.title}`
                return (
                  <tr key={key} className={key === open ? 'selected' : undefined}>
                    <td>
                      <button type="button" className="link-button" aria-pressed={key === open} onClick={() => setOpen(key === open ? null : key)}>{row.title}</button>
                    </td>
                    <td>{row.before ? row.before.toLocaleString() : ''}</td>
                    <td>{row.after ? row.after.toLocaleString() : ''}</td>
                    <td className="compare-added">{row.added ? `+${row.added.toLocaleString()}` : ''}</td>
                    <td className="compare-removed">{row.removed ? `−${row.removed.toLocaleString()}` : ''}</td>
                    <td className="stats-bar-cell">
                      <span className="compare-bars">
                        <span className="compare-bar-removed" style={{ width: `${(row.removed / peak) * 50}%` }} />
                        <span className="compare-bar-added" style={{ width: `${(row.added / peak) * 50}%` }} />
                      </span>
                    </td>
                    <td>{row.before || row.after ? `${row.similarity}%` : ''}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </>
      )}
      {detail && open && (
        <section className="compare-detail" aria-label="Sentences of the section chosen">
          <h3 className="stats-heading">
            {open.slice(open.indexOf(':') + 1)}
            <button type="button" className="link-button style-open" onClick={() => onOpenSection(Number(open.split(':')[0]))}>Go to section</button>
          </h3>
          {detail.length === 0 && <p className="lexical-hint">Nothing in either layer.</p>}
          {detail.map((change, index) => (
            <p key={index} className={`compare-sentence compare-${change.kind}`}>
              <span className="compare-sign" aria-label={change.kind}>{change.kind === 'added' ? '+' : change.kind === 'removed' ? '−' : ''}</span>
              {change.text}
            </p>
          ))}
        </section>
      )}
    </div>
  )
}
