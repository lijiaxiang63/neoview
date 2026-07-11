import { useState, type JSX, type ReactNode } from 'react'
import { useStore } from '../store'

/**
 * Collapsible titled block. Three ownership modes for the open state:
 * controlled (`open`/`onToggle`), persisted (`persistId` — lives in the
 * store's collapsedSections and survives restarts), or local
 * (`defaultOpen`, resets per mount). Children unmount while closed so
 * expensive content (label inventories) is only built on expand.
 */
export function CollapsibleSection({
  title,
  badge,
  persistId,
  defaultOpen = true,
  open,
  onToggle,
  children
}: {
  title: string
  /** Extra header text after the title, e.g. a count. */
  badge?: string
  persistId?: string
  defaultOpen?: boolean
  open?: boolean
  onToggle?: (open: boolean) => void
  children: ReactNode
}): JSX.Element {
  const collapsedSections = useStore((s) => s.collapsedSections)
  const toggleSection = useStore((s) => s.toggleSection)
  const [localOpen, setLocalOpen] = useState(defaultOpen)

  const controlled = open !== undefined
  const isOpen = controlled ? open : persistId ? !collapsedSections[persistId] : localOpen

  const toggle = (): void => {
    if (controlled) onToggle?.(!open)
    else if (persistId) toggleSection(persistId)
    else setLocalOpen(!localOpen)
  }

  return (
    <div className="collapse-section">
      <button className="collapse-head" aria-expanded={isOpen} onClick={toggle}>
        <span className="chevron" aria-hidden="true">
          {isOpen ? '▾' : '▸'}
        </span>
        {title}
        {badge && <span className="collapse-badge">{badge}</span>}
      </button>
      {isOpen && <div className="collapse-body">{children}</div>}
    </div>
  )
}
