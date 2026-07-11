import { useSyncExternalStore, type JSX } from 'react'
import type { UpdatePresenter } from '../runtime/updatePresenter'

function fmtMB(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

/** Application-owned update state rendered as one notification card. */
export function UpdateNotif({ presenter }: { presenter: UpdatePresenter }): JSX.Element | null {
  const { update, commandPending } = useSyncExternalStore(
    presenter.subscribe,
    presenter.getSnapshot,
    presenter.getSnapshot
  )
  const state = update.state
  if (state.phase === 'idle') return null

  return (
    <div className={'notif' + (state.phase === 'error' ? ' error' : '')}>
      {state.phase === 'checking' && <span className="msg">Checking for updates…</span>}
      {state.phase === 'none' && <span className="msg">You’re up to date (v{state.version}).</span>}
      {state.phase === 'error' && <span className="msg">Update check failed: {state.message}</span>}
      {state.phase === 'available' && (
        <>
          <div className="notif-row">
            <span className="msg">Update available: v{state.info.version}</span>
            <button
              className="notif-action"
              onClick={() => presenter.openNotes(state.info.notesUrl)}
            >
              What’s new
            </button>
          </div>
          {state.error && <div className="notif-detail">{state.error}</div>}
          <div className="notif-row">
            <button
              className="btn primary"
              disabled={commandPending}
              onClick={() => void presenter.download(state.info, update)}
            >
              Download{state.info.assetSize > 0 ? ' (' + fmtMB(state.info.assetSize) + ')' : ''}
            </button>
            <button
              className="notif-action"
              disabled={commandPending}
              onClick={() => presenter.skip(state.info.version, update)}
            >
              Skip this version
            </button>
          </div>
        </>
      )}
      {state.phase === 'downloading' && (
        <>
          <div className="notif-row">
            <span className="msg">
              Downloading v{state.info.version}… {fmtMB(state.received)}
              {state.total > 0 ? ' / ' + fmtMB(state.total) : ''}
            </span>
            <button
              className="notif-action"
              disabled={commandPending}
              onClick={() => presenter.dismiss(update)}
            >
              Cancel
            </button>
          </div>
          <div className="notif-progress">
            <div
              className="fill"
              style={{
                width:
                  state.total > 0 ? Math.min(100, (state.received / state.total) * 100) + '%' : 0
              }}
            />
          </div>
        </>
      )}
      {state.phase === 'ready' && (
        <>
          <div className="notif-row">
            <span className="msg">v{state.info.version} downloaded.</span>
            <button
              className="btn primary"
              disabled={commandPending}
              onClick={() => void presenter.install(state.info, update)}
            >
              {presenter.platform === 'darwin'
                ? 'Quit & install'
                : presenter.platform === 'linux'
                  ? 'Save installer'
                  : 'Restart to install'}
            </button>
          </div>
          {state.error && <div className="notif-detail">{state.error}</div>}
        </>
      )}
      {state.phase === 'saved' && (
        <span className="msg">Installer saved — run it to finish updating.</span>
      )}
      <button
        className="notif-close"
        aria-label="Dismiss"
        disabled={commandPending}
        onClick={() => presenter.dismiss(update)}
      >
        ✕
      </button>
    </div>
  )
}
