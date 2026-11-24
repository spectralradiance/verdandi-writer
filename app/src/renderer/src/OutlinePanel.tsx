import { ChevronDown, ChevronRight } from 'lucide-react'
import { useMemo, useState } from 'react'

import { outlineMarkdown } from '../../shared/outline'
import type { Outline } from './useOutline'

interface OutlinePanelProps {
  outline: Outline | null
  onReveal: (path: string, line: number) => void
}

interface OutlineNode {
  key: string
  text: string
  line: number
  level: number
  /** A section of the document (else a heading inside one). */
  section: boolean
  children: OutlineNode[]
}

/** A section's `level` field (1 to 6), if it has one. */
function levelField(value: unknown): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isInteger(number) && number >= 1 && number <= 6 ? number : null
}

/**
 * The sections and the headings inside them, nested by level: a section's `level`
 * field (a folder document's), else its heading's level.
 */
function outlineTree(outline: Outline): OutlineNode[] {
  const roots: OutlineNode[] = []
  const stack: OutlineNode[] = []
  const place = (node: OutlineNode) => {
    while (stack.length && stack[stack.length - 1].level >= node.level) stack.pop()
    ;(stack.length ? stack[stack.length - 1].children : roots).push(node)
    stack.push(node)
  }
  for (const section of outline.sections) {
    if (section.title === null) continue
    const level = levelField(section.id === null ? undefined : outline.fields[section.id]?.level) ?? section.level
    place({ key: `s${section.line}:${section.title}`, text: section.title, line: section.line, level, section: true, children: [] })
    // The headings inside a section sit under it, nested from the shallowest of them.
    const shallowest = Math.min(...section.headings.map((heading) => heading.level))
    for (const heading of section.headings) {
      place({ key: `h${heading.line}:${heading.text}`, text: heading.text, line: heading.line, level: level + 1 + heading.level - shallowest, section: false, children: [] })
    }
  }
  return roots
}

const indent = (depth: number) => ({ paddingLeft: `${8 + depth * 14}px` })

function OutlineBranch({ nodes, depth, closed, onToggle, onOpen }: {
  nodes: OutlineNode[]
  depth: number
  closed: ReadonlySet<string>
  onToggle: (key: string) => void
  onOpen: (line: number) => void
}) {
  return (
    <ul className="outline-tree" role={depth === 0 ? 'tree' : 'group'}>
      {nodes.map((node) => {
        const open = !closed.has(node.key)
        const parent = node.children.length > 0
        return (
          <li key={node.key} role="treeitem" aria-expanded={parent ? open : undefined}>
            <div className="tree-row-wrap">
              <button type="button" className={`tree-row outline-row${node.section ? ' outline-section' : ' outline-heading'}`} style={indent(depth)}
                onClick={() => onOpen(node.line)} title={node.text}>
                <span className="tree-chevron" role={parent ? 'button' : undefined} aria-label={parent ? (open ? 'Collapse' : 'Expand') : undefined}
                  onClick={parent ? (event) => {
                    event.stopPropagation()
                    onToggle(node.key)
                  } : undefined}>
                  {parent && (open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />)}
                </span>
                <span className="tree-label">{node.text}</span>
              </button>
            </div>
            {parent && open && <OutlineBranch nodes={node.children} depth={depth + 1} closed={closed} onToggle={onToggle} onOpen={onOpen} />}
          </li>
        )
      })}
    </ul>
  )
}

/** The document's structure as a tree: its sections in order, nested by level, with the headings inside them. */
export function OutlinePanel({ outline, onReveal }: OutlinePanelProps) {
  const [copied, setCopied] = useState(false)
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set())
  const tree = useMemo(() => (outline ? outlineTree(outline) : []), [outline])

  if (!outline) return <p className="sidebar-empty">Open a document to see its outline.</p>

  const copy = () => {
    void navigator.clipboard.writeText(outlineMarkdown(outline.title, outline.sections)).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
  }
  const toggle = (key: string) => setClosed((current) => {
    const next = new Set(current)
    if (!next.delete(key)) next.add(key)
    return next
  })
  const parents = (nodes: OutlineNode[]): string[] => nodes.flatMap((node) => (node.children.length ? [node.key, ...parents(node.children)] : []))

  return (
    <div className="outline-panel">
      <header className="outline-head">
        <div className="outline-title">{outline.title}</div>
        {tree.length > 0 && (
          <div className="outline-controls">
            <span>
              <button type="button" className="link-button" onClick={() => setClosed(new Set())}>Expand all</button>
              {' · '}
              <button type="button" className="link-button" onClick={() => setClosed(new Set(parents(tree)))}>Collapse all</button>
            </span>
            <button type="button" className="link-button" onClick={copy} title="Copy the outline as a Markdown list">{copied ? 'Copied' : 'Copy'}</button>
          </div>
        )}
      </header>
      {tree.length === 0
        ? <p className="sidebar-empty">No sections yet. Each line starting with # starts a section.</p>
        : <OutlineBranch nodes={tree} depth={0} closed={closed} onToggle={toggle} onOpen={(line) => onReveal(outline.path, line)} />}
    </div>
  )
}
