import { type JSX } from 'react'
import { useStore } from '../store'
import { ToastNotif } from './Toast'
import { UpdateNotif } from './UpdateNotif'
import type { UpdatePresenter } from '../runtime/updatePresenter'

/**
 * One bottom-right stack for every transient message: the load error (store
 * `errorMessage`), store toasts (undo / reveal), and the IPC-driven update
 * lifecycle. UpdateNotif owns its own visibility, so the stack stays mounted
 * even when it looks empty (an empty stack is invisible and click-through).
 */
export function NotificationCenter({
  updates,
  revealInFolder
}: {
  updates: UpdatePresenter
  revealInFolder(path: string): void
}): JSX.Element {
  const toasts = useStore((s) => s.toasts)
  const errorMessage = useStore((s) => s.errorMessage)
  const dismissError = useStore((s) => s.dismissError)

  return (
    <div className="notif-stack">
      {errorMessage && (
        <div className="notif error">
          <div className="notif-row">
            <span className="msg">{errorMessage}</span>
          </div>
          <button className="notif-close" aria-label="Dismiss" onClick={dismissError}>
            ✕
          </button>
        </div>
      )}
      {toasts.map((t) => (
        <ToastNotif key={t.id} item={t} revealInFolder={revealInFolder} />
      ))}
      <UpdateNotif presenter={updates} />
    </div>
  )
}
