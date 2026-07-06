import { useEffect, type JSX } from 'react'
import { useStore } from '../store'

const TOAST_MS = 6000

export function Toast(): JSX.Element | null {
  const toast = useStore((s) => s.toast)
  const setToast = useStore((s) => s.setToast)
  const undoDeleteRegion = useStore((s) => s.undoDeleteRegion)

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), TOAST_MS)
    return () => clearTimeout(t)
  }, [toast, setToast])

  if (!toast) return null

  const onAction = (): void => {
    const action = toast.action
    if (!action) return
    if (action.kind === 'undo-delete') {
      undoDeleteRegion()
    } else {
      window.neoview.revealInFolder(action.path)
      setToast(null)
    }
  }

  return (
    <div className="toast">
      <span className="msg">{toast.text}</span>
      {toast.action && (
        <button className="toast-action" onClick={onAction}>
          {toast.action.label}
        </button>
      )}
      <button className="toast-close" aria-label="Dismiss" onClick={() => setToast(null)}>
        ✕
      </button>
    </div>
  )
}
