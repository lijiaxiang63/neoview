import { useEffect, type JSX } from 'react'

interface Props {
  onClose: () => void
}

const IS_MAC = window.neoview.platform === 'darwin'
const MOD = IS_MAC ? '⌘' : 'Ctrl'

interface Row {
  keys: string
  what: string
}

interface Section {
  title: string
  rows: Row[]
}

const SECTIONS: Section[] = [
  {
    title: 'Files',
    rows: [
      { keys: `${MOD} O`, what: 'Open a volume file' },
      { keys: `${MOD} ⇧ O`, what: 'Open a folder' },
      { keys: '↑ / ↓', what: 'Previous / next file in the opened folder' },
      { keys: `${MOD} Z / ${MOD} ⇧ Z`, what: 'Undo / redo region edits' }
    ]
  },
  {
    title: 'Slice views',
    rows: [
      { keys: 'Wheel', what: 'Step through slices' },
      { keys: 'Click / drag', what: 'Move the crosshair (Navigate tool)' },
      { keys: 'Double-click', what: 'Maximize the view (Esc or double-click restores)' },
      { keys: 'Right-click a region', what: 'Re-segment it (Navigate tool)' }
    ]
  },
  {
    title: 'Segmentation',
    rows: [
      { keys: 'Drag (Box tool)', what: 'Draw a box; drag its edges or corners to resize' },
      { keys: 'Enter', what: 'Commit the previewed region' },
      { keys: 'Esc', what: 'Cancel the drawn box' },
      { keys: '[ / ]', what: 'Smaller / larger brush' },
      { keys: 'Alt-drag or right-drag', what: 'Erase with the brush' }
    ]
  },
  {
    title: '3D view',
    rows: [
      { keys: 'Drag', what: 'Orbit' },
      { keys: 'Wheel', what: 'Zoom' },
      { keys: 'Double-click', what: 'Reset the camera' }
    ]
  },
  {
    title: 'Panels',
    rows: [
      { keys: `${MOD} B`, what: 'Toggle the side panel' },
      { keys: `${MOD} ⇧ B`, what: 'Toggle the file list' },
      { keys: '?', what: 'Show this overview' }
    ]
  }
]

/** Modal list of every shortcut and gesture. Esc, ✕ or a backdrop click closes. */
export function ShortcutsOverlay({ onClose }: Props): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        // Capture phase so Esc closes only the overlay (not also the seg box).
        e.stopPropagation()
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <div className="shortcuts-backdrop" onPointerDown={onClose}>
      <div
        className="shortcuts-panel"
        role="dialog"
        aria-label="Keyboard shortcuts"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <header>
          <h2>Keyboard shortcuts</h2>
          <button className="icon-close" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="shortcuts-grid">
          {SECTIONS.map((s) => (
            <section key={s.title}>
              <h3>{s.title}</h3>
              <dl>
                {s.rows.map((r) => (
                  <div className="shortcut-row" key={r.keys + r.what}>
                    <dt className="mono">{r.keys}</dt>
                    <dd>{r.what}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
