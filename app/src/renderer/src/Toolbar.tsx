import type { ComponentProps } from 'react'
import { Code, Eye, Focus, type LucideIcon } from 'lucide-react'

// Toolbar buttons are icons: the label is the accessible name, the title the tooltip.
const ICON = { size: 16, strokeWidth: 1.8, 'aria-hidden': true } as const

export function IconButton({ icon: Icon, label, title, ...props }: { icon: LucideIcon; label: string; title?: string } & ComponentProps<'button'>) {
  return (
    <button type="button" className="tool-button" aria-label={label} title={title ?? label} {...props}>
      <Icon {...ICON} />
    </button>
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
