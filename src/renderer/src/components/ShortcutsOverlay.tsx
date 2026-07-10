import { useEffect, useRef, type JSX } from 'react'

interface Props {
  isMac: boolean
  onClose: () => void
}

interface Row {
  keys: string
  what: string
}

interface Section {
  title: string
  rows: Row[]
}

function sections(mod: string): Section[] {
  return [
    {
      title: 'Files',
      rows: [
        { keys: `${mod} O`, what: 'Open a volume file' },
        { keys: `${mod} ⇧ O`, what: 'Open a folder' },
        { keys: '↑ / ↓', what: 'Previous / next file in the opened folder' },
        { keys: `${mod} Z / ${mod} ⇧ Z`, what: 'Undo / redo region edits' }
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
        { keys: `${mod} B`, what: 'Toggle the side panel' },
        { keys: `${mod} ⇧ B`, what: 'Toggle the file list' },
        { keys: '?', what: 'Show this overview' }
      ]
    }
  ]
}

/** Modal list of every shortcut and gesture. Esc, ✕ or a backdrop click closes. */
export function ShortcutsOverlay({ isMac, onClose }: Props): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null)
  const rows = sections(isMac ? '⌘' : 'Ctrl')

  // Take focus on open: a toolbar/region button focused behind the modal
  // would otherwise keep receiving Enter/Space activation — that's a browser
  // default action, not a listener, so stopping propagation can't block it.
  useEffect(() => {
    panelRef.current?.focus()
  }, [])

  useEffect(() => {
    // Capture phase, every key: the dialog is modal, so no keystroke may
    // reach the app-level shortcut handler underneath (Enter would commit a
    // drawn preview, arrows would switch files). Immediate-stop, because
    // sibling listeners on the same window target ignore a plain stop.
    // Default actions (Tab, in-dialog button activation, scrolling) still work.
    const onKey = (e: KeyboardEvent): void => {
      e.stopImmediatePropagation()
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      // Activation keys are default actions: if focus has wandered back
      // behind the modal (Tab past the close button), cancel them so hidden
      // controls can't be triggered while the dialog is up.
      if (e.key === 'Enter' || e.key === ' ') {
        const panel = panelRef.current
        if (!panel || !(e.target instanceof Node) || !panel.contains(e.target)) {
          e.preventDefault()
        }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <div className="shortcuts-backdrop" onPointerDown={onClose}>
      <div
        ref={panelRef}
        className="shortcuts-panel"
        role="dialog"
        aria-label="Keyboard shortcuts"
        tabIndex={-1}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <header>
          <h2>Keyboard shortcuts</h2>
          <button className="icon-close" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="shortcuts-grid">
          {rows.map((s) => (
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
