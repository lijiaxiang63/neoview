import { useEffect, type JSX } from 'react'
import { useStore, type ToastItem } from '../store'

const TOAST_MS = 6000

/** One store toast rendered as a notification card. Each item owns its own
 * auto-dismiss timer so entries in the stack expire independently. */
export function ToastNotif({ item }: { item: ToastItem }): JSX.Element {
  const dismissToast = useStore((s) => s.dismissToast)
  const undo = useStore((s) => s.undo)

  useEffect(() => {
    const t = setTimeout(() => dismissToast(item.id), TOAST_MS)
    return () => clearTimeout(t)
  }, [item.id, dismissToast])

  const onAction = (): void => {
    const action = item.action
    if (!action) return
    if (action.kind === 'undo') undo()
    else window.neoview.revealInFolder(action.path)
    dismissToast(item.id)
  }

  const variant = item.variant === 'success' || item.variant === 'error' ? ` ${item.variant}` : ''

  return (
    <div className={`notif${variant}`}>
      <div className="notif-row">
        <span className="msg">{item.text}</span>
        {item.action && (
          <button className="notif-action" onClick={onAction}>
            {item.action.label}
          </button>
        )}
      </div>
      <button className="notif-close" aria-label="Dismiss" onClick={() => dismissToast(item.id)}>
        ✕
      </button>
    </div>
  )
}
