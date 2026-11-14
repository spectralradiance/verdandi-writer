import type { ComponentProps } from 'react'
import { Code, Columns2, Eye, FileText, Focus, type LucideIcon, NotebookPen } from 'lucide-react'

import type { CellKind } from './editor/sectionModel'

// Toolbar buttons are icons: the label is the accessible name, the title the tooltip.
const ICON = { size: 16, strokeWidth: 1.8, 'aria-hidden': true } as const

export function IconButton({ icon: Icon, label, title, ...props }: { icon: LucideIcon; label: string; title?: string } & ComponentProps<'button'>) {
  return (
    <button type="button" className="tool-button" aria-label={label} title={title ?? label} {...props}>
      <Icon {...ICON} />
    </button>
  )
}

const VIEWS: { id: CellKind; label: string; title: string; icon: LucideIcon }[] = [
  { id: 'output', icon: FileText, label: 'Text view', title: 'each section’s text first, with its notes beside it' },
  { id: 'notes', icon: NotebookPen, label: 'Notes view', title: 'each section’s notes first, with its text beside it' },
]

/** Which side of each section comes first, and whether the other side is shown. */
export function ViewSwitch({ primary, onPrimary, secondaryShown, onSecondaryShown }: {
  primary: CellKind
  onPrimary: (primary: CellKind) => void
  secondaryShown: boolean
  onSecondaryShown: (shown: boolean) => void
}) {
  const other = primary === 'output' ? 'notes' : 'text'
  return (
    <>
      <div className="segmented" role="group" aria-label="Document view">
        {VIEWS.map((option) => (
          <IconButton key={option.id} icon={option.icon} label={option.label} title={`${option.label}: ${option.title}`} aria-pressed={primary === option.id} onClick={() => onPrimary(option.id)} />
        ))}
      </div>
      <IconButton
        icon={Columns2}
        label={secondaryShown ? `Hide all ${other}` : `Show all ${other}`}
        title={`${secondaryShown ? 'Hide' : 'Show'} the ${other} beside every section. Each section can be shown or hidden on its own too; Ctrl+Alt+N moves between a section’s text and notes.`}
        aria-pressed={secondaryShown}
        onClick={() => onSecondaryShown(!secondaryShown)}
      />
    </>
  )
}

interface ModeProps {
  live: boolean
  focusMode: boolean
  onToggleLive: () => void
  onToggleFocus: () => void
}

export function ModeToggles({ live, focusMode, onToggleLive, onToggleFocus }: ModeProps) {
  return (
    <div className="mode-toggles">
      <div className="segmented" role="group" aria-label="Editing mode">
        <IconButton icon={Eye} label="Live" title="Live rendering (Ctrl+/)" aria-pressed={live} onClick={live ? undefined : onToggleLive} />
        <IconButton icon={Code} label="Source" title="Markdown source (Ctrl+/)" aria-pressed={!live} onClick={live ? onToggleLive : undefined} />
      </div>
      <IconButton icon={Focus} label="Focus mode" title="Focus mode (F8)" aria-pressed={focusMode} onClick={onToggleFocus} />
    </div>
  )
}
