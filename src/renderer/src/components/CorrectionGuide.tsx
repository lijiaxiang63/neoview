import { useEffect, useRef, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { correctionGuideSections } from './correctionGuideContent'

interface Props {
  onClose: () => void
}

/**
 * Modal explaining the correction methods, parameters, readout, and caveats.
 * Esc, ✕, or a backdrop click closes. Mirrors ShortcutsOverlay's focus and
 * capture-phase key handling so no keystroke reaches the panel behind it (the
 * Correction panel sits amid number inputs and the app-level shortcut router).
 */
export function CorrectionGuide({ onClose }: Props): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null)
  const sections = correctionGuideSections()

  // Take focus on open so activation keys can't reach a control behind the modal.
  useEffect(() => {
    panelRef.current?.focus()
  }, [])

  useEffect(() => {
    // Capture phase, every key: the dialog is modal, so no keystroke may reach
    // the app-level shortcut handler underneath. Immediate-stop because sibling
    // listeners on the same window target ignore a plain stop. Default actions
    // (Tab, in-dialog activation, scrolling) still work.
    const onKey = (e: KeyboardEvent): void => {
      e.stopImmediatePropagation()
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
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

  // Portal to <body>: this component lives inside the side-panel subtree, which
  // Cmd+B hides with display:none WITHOUT unmounting. A modal rendered in that
  // subtree would go invisible while its capture-phase key listener kept
  // swallowing every keystroke app-wide. Portaling the DOM out keeps the modal
  // visible and the "listener active ⟺ modal visible" invariant intact.
  return createPortal(
    <div className="corr-guide-backdrop" onPointerDown={onClose}>
      <div
        ref={panelRef}
        className="corr-guide-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Multiple-comparison correction guide"
        tabIndex={-1}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <header>
          <h2>Multiple-comparison correction</h2>
          <button className="icon-close" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="corr-guide-body">
          {sections.map((s) => (
            <section key={s.title}>
              <h3>{s.title}</h3>
              {s.lead && <p className="corr-guide-lead">{s.lead}</p>}
              {s.entries.length > 0 && (
                <dl>
                  {s.entries.map((e) => (
                    <div className="corr-guide-row" key={e.term}>
                      <dt>{e.term}</dt>
                      <dd>{e.desc}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </section>
          ))}
        </div>
      </div>
    </div>,
    document.body
  )
}
