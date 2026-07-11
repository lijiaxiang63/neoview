import { useRef, type JSX } from 'react'
import { tabButtonId, tabPanelId } from './tabIds'

export interface TabDef {
  id: string
  label: string
  /** Small count pill; hidden when undefined or zero. */
  badge?: number
  title?: string
}

/**
 * Stateless ARIA tab strip: roving tabindex, ArrowLeft/Right cycling,
 * Home/End jumps, selection follows focus. The matching tabpanels are
 * rendered by the caller with id `${idPrefix}-panel-${tab.id}`.
 */
export function Tabs({
  tabs,
  active,
  onSelect,
  idPrefix
}: {
  tabs: TabDef[]
  active: string
  onSelect: (id: string) => void
  idPrefix: string
}): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)

  const select = (id: string): void => {
    onSelect(id)
    listRef.current
      ?.querySelector<HTMLButtonElement>(`[id="${tabButtonId(idPrefix, id)}"]`)
      ?.focus()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const index = tabs.findIndex((t) => t.id === active)
    let next: number
    if (e.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length
    else if (e.key === 'ArrowRight') next = (index + 1) % tabs.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = tabs.length - 1
    else return
    e.preventDefault()
    select(tabs[next].id)
  }

  return (
    <div ref={listRef} className="panel-tabs" role="tablist" onKeyDown={onKeyDown}>
      {tabs.map((t) => (
        <button
          key={t.id}
          id={tabButtonId(idPrefix, t.id)}
          className="panel-tab"
          role="tab"
          aria-selected={t.id === active}
          aria-controls={tabPanelId(idPrefix, t.id)}
          tabIndex={t.id === active ? 0 : -1}
          title={t.title}
          onClick={() => select(t.id)}
        >
          {t.label}
          {t.badge !== undefined && t.badge > 0 && (
            <span className="tab-badge mono">{t.badge}</span>
          )}
        </button>
      ))}
    </div>
  )
}
