import { type JSX } from 'react'
import { useStore } from '../store'

interface Props {
  onOpen: () => void
  sidebarOpen: boolean
  onToggleSidebar: () => void
}

const isMac = navigator.platform.toLowerCase().includes('mac')

export function Toolbar({ onOpen, sidebarOpen, onToggleSidebar }: Props): JSX.Element {
  const volume = useStore((s) => s.volume)

  return (
    <header className={`toolbar${isMac ? ' mac-inset' : ''}`}>
      <div className="brand">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect x="1" y="4" width="9" height="9" rx="1.5" stroke="#4fa3ff" strokeWidth="1.5" />
          <rect
            x="5.5"
            y="1.5"
            width="9"
            height="9"
            rx="1.5"
            stroke="#9aa3b0"
            strokeWidth="1.2"
            opacity="0.6"
          />
        </svg>
        neoview
      </div>
      <div className="filename mono">{volume ? volume.name : ''}</div>
      <div className="actions">
        <button className="btn" onClick={onOpen}>
          Open…
        </button>
        <button
          className={`btn${sidebarOpen ? ' toggled' : ''}`}
          aria-pressed={sidebarOpen}
          title={sidebarOpen ? 'Hide panel' : 'Show panel'}
          onClick={onToggleSidebar}
        >
          Panel
        </button>
      </div>
    </header>
  )
}
