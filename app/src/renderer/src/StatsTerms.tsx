import { TriangleAlert, X } from 'lucide-react'
import { useMemo, useState } from 'react'

import { splitSections } from '../../shared/document'
import { layerText } from '../../shared/layerStats'
import { suggestTerms, type TermUse, trackTerms } from '../../shared/terms'
import { readPref, writePref } from './prefs'

interface StatsTermsProps {
  /** The document, whose terms are kept for it on this computer. */
  path: string
  text: string
  layerNames: string[] | null
  layer: string
  onOpenSection: (line: number) => void
}

const termsKey = (path: string) => `terms:${path.toLowerCase()}`

function readTerms(path: string): string[] {
  try {
    const value: unknown = JSON.parse(readPref(termsKey(path)) ?? '[]')
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

/** A term's uses across the sections, one cell each: darker for more, outlined where it is defined. */
function TermStrip({ use, titles }: { use: TermUse; titles: readonly string[] }) {
  const peak = Math.max(1, ...use.counts)
  const width = Math.max(120, use.counts.length * 4)
  const cell = width / Math.max(1, use.counts.length)
  return (
    <svg className="term-strip" viewBox={`0 0 ${width} 14`} preserveAspectRatio="none" role="img"
      aria-label={`${use.term}: used in ${use.sections} of ${use.counts.length} sections`}>
      {use.counts.map((count, index) => (
        <rect key={index} x={index * cell} width={Math.max(1, cell - 0.5)} y={0} height={14}
          className={`term-cell${index === use.defined ? ' term-defined' : ''}`} style={{ opacity: count ? 0.25 + (0.75 * count) / peak : 0.06 }}>
          <title>{`${titles[index]}: ${count} ${count === 1 ? 'use' : 'uses'}${index === use.defined ? ' (defined here)' : ''}`}</title>
        </rect>
      ))}
    </svg>
  )
}

/**
 * The document's terms: where each is used, section by section, where it is first
 * used and where it is defined (its first emphasized or quoted use), and a warning
 * when a section uses it before the one that defines it.
 */
export function StatsTerms({ path, text, layerNames, layer, onOpenSection }: StatsTermsProps) {
  const [terms, setTerms] = useState(() => readTerms(path))
  const [draft, setDraft] = useState('')
  const [suggested, setSuggested] = useState<string[] | null>(null)

  const sections = useMemo(() => splitSections(text, layerNames).filter((section) => section.title !== null)
    .map((section) => ({ title: section.title!, line: section.line, text: layerText(section, layer, layerNames) })), [text, layerNames, layer])
  const uses = useMemo(() => trackTerms(sections, terms), [sections, terms])
  const titles = sections.map((section) => section.title)

  const save = (next: string[]) => {
    setTerms(next)
    writePref(termsKey(path), next.length ? JSON.stringify(next) : null)
  }
  const add = (raw: string) => {
    const fresh = raw.split(',').map((term) => term.trim()).filter((term) => term && !terms.some((known) => known.toLowerCase() === term.toLowerCase()))
    if (fresh.length) save([...terms, ...fresh])
    setSuggested((current) => current?.filter((term) => !fresh.some((added) => added.toLowerCase() === term.toLowerCase())) ?? null)
  }
  const sectionLink = (index: number | null) => (index === null
    ? <span className="lexical-hint">–</span>
    : <button type="button" className="link-button" onClick={() => onOpenSection(sections[index].line)}>{sections[index].title}</button>)

  return (
    <div className="settings-section">
      <div className="terms-add">
        <input value={draft} placeholder="Add terms, separated by commas" aria-label="Add terms" onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              add(draft)
              setDraft('')
            }
          }} />
        <button type="button" className="find-text-button" disabled={!draft.trim()} onClick={() => { add(draft); setDraft('') }}>Add</button>
        <button type="button" className="find-text-button" title="Words this layer puts in bold, italics or quotes, and capitalized words it uses often"
          onClick={() => setSuggested(suggestTerms(sections.map((section) => section.text).join('\n\n'), terms))}>Suggest terms</button>
      </div>
      {suggested !== null && (
        <div className="terms-suggested">
          {suggested.length === 0 ? <span className="lexical-hint">Nothing more to suggest.</span> : (
            <>
              <span className="lexical-hint">Suggested (click to add):</span>
              {suggested.map((term) => <button key={term} type="button" className="term-chip" onClick={() => add(term)}>{term}</button>)}
              <button type="button" className="link-button" onClick={() => add(suggested.join(','))}>Add all</button>
            </>
          )}
        </div>
      )}
      {terms.length === 0 ? (
        <p className="lexical-hint">No terms yet. Add the words this document defines and relies on, or let it suggest some; they are kept for this document on this computer.</p>
      ) : (
        <table className="settings-table stats-table terms-table">
          <thead>
            <tr><th>Term</th><th>Uses</th><th>Sections</th><th>First used</th><th>Defined</th><th className="terms-strip-head">Across the document</th><th /></tr>
          </thead>
          <tbody>
            {uses.map((use) => (
              <tr key={use.term}>
                <td>
                  {use.term}
                  {use.beforeDefinition && (
                    <span className="term-warning" title={`Used in “${sections[use.first!].title}” before it is defined in “${sections[use.defined!].title}”`}>
                      <TriangleAlert size={13} aria-label="Used before it is defined" />
                    </span>
                  )}
                </td>
                <td>{use.total ? use.total.toLocaleString() : <span className="lexical-hint">unused</span>}</td>
                <td>{use.sections || ''}</td>
                <td>{sectionLink(use.first)}</td>
                <td>{sectionLink(use.defined)}</td>
                <td><TermStrip use={use} titles={titles} /></td>
                <td>
                  <button type="button" className="icon-button" aria-label={`Stop tracking ${use.term}`} title="Stop tracking"
                    onClick={() => save(terms.filter((term) => term !== use.term))}><X size={13} aria-hidden="true" /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="lexical-hint">
        A term counts in any case and with a plural ending. It is taken to be defined where it is first in bold, italics or quotes; a
        <TriangleAlert size={12} aria-hidden="true" className="term-inline-icon" /> marks one used in an earlier section than that.
      </p>
    </div>
  )
}
