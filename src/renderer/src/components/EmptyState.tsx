import { type JSX } from 'react'

interface Props {
  onOpen: () => void
}

const isMac = navigator.platform.toLowerCase().includes('mac')

export function EmptyState({ onOpen }: Props): JSX.Element {
  return (
    <div className="empty-state">
      <div className="drop-zone">
        <svg width="56" height="56" viewBox="0 0 56 56" fill="none">
          <rect x="6" y="16" width="30" height="30" rx="4" stroke="#4fa3ff" strokeWidth="2" />
          <rect
            x="16"
            y="10"
            width="30"
            height="30"
            rx="4"
            stroke="#9aa3b0"
            strokeWidth="1.6"
            opacity="0.55"
          />
          <rect
            x="26"
            y="4"
            width="24"
            height="24"
            rx="4"
            stroke="#5c6570"
            strokeWidth="1.4"
            opacity="0.4"
          />
        </svg>
        <h2>Drop a .nii or .nii.gz file</h2>
        <span className="hint">or press {isMac ? '⌘O' : 'Ctrl+O'} to browse</span>
        <button className="btn primary" onClick={onOpen}>
          Open file…
        </button>
      </div>
    </div>
  )
}
