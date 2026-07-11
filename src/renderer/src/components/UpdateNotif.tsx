import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import type { UpdateRef, UpdateState } from '../../../shared/updates'
import {
  INITIAL_UPDATE_SNAPSHOT,
  ownedUpdateFallback,
  UpdateCommandLatch,
  type UpdateCommandOwner,
  UpdateSnapshotReceiver,
  updateResultAutoDismisses
} from '../runtime/updateSnapshots'

const RESULT_MS = 6000

function fmtMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function ipcErrorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : 'Update failed.'
  return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/** Application-owned update state rendered as one notification card. The
 * initial snapshot makes downloads and completed work survive window rebuilds. */
export function UpdateNotif(): JSX.Element | null {
  const [snapshot, setSnapshot] = useState(INITIAL_UPDATE_SNAPSHOT)
  const latestSnapshot = useRef(INITIAL_UPDATE_SNAPSHOT)
  const commandLatch = useRef(new UpdateCommandLatch())
  const [commandPending, setCommandPending] = useState(false)
  const state = snapshot.state

  useEffect(() => {
    const receiver = new UpdateSnapshotReceiver()
    const latch = commandLatch.current
    const accept = (next: Parameters<UpdateSnapshotReceiver['accept']>[0]): void => {
      const accepted = receiver.accept(next)
      if (accepted) {
        const advanced = accepted.revision > latestSnapshot.current.revision
        latestSnapshot.current = accepted
        if (advanced && latch.reset()) setCommandPending(false)
        setSnapshot(accepted)
      }
    }
    const unsubscribe = window.neoview.onUpdateState((next) => {
      accept(next)
    })
    void window.neoview
      .getUpdateState()
      .then(accept)
      .catch(() => {})
    return () => {
      receiver.dispose()
      latch.reset()
      unsubscribe()
    }
  }, [])

  const beginCommand = useCallback((): UpdateCommandOwner | null => {
    const latest = latestSnapshot.current
    // An IPC event can advance ownership just before React commits its render;
    // an event handler from the old card must not send that stale command.
    if (latest.revision !== snapshot.revision || latest.commandId !== snapshot.commandId)
      return null
    const token = commandLatch.current.begin()
    if (token === null) return null
    setCommandPending(true)
    return { token, revision: snapshot.revision, commandId: snapshot.commandId }
  }, [snapshot.commandId, snapshot.revision])

  const finishCommand = useCallback((token: number): void => {
    if (commandLatch.current.release(token)) setCommandPending(false)
  }, [])

  const setLocalFallback = useCallback((owner: UpdateCommandOwner, state: UpdateState): void => {
    const next = ownedUpdateFallback(latestSnapshot.current, owner, commandLatch.current, state)
    if (!next) return
    latestSnapshot.current = next
    setSnapshot(next)
  }, [])

  useEffect(() => {
    if (!updateResultAutoDismisses(state)) return
    const timer = setTimeout(() => {
      const command = beginCommand()
      if (command) window.neoview.dismissUpdate(command.commandId)
    }, RESULT_MS)
    return () => clearTimeout(timer)
  }, [beginCommand, state])

  const download = async (info: UpdateRef): Promise<void> => {
    const command = beginCommand()
    if (!command) return
    try {
      await window.neoview.downloadUpdate(command.commandId)
    } catch (error) {
      // The main service normally publishes this state first; this fallback
      // covers a transport failure where no event can arrive.
      setLocalFallback(command, { phase: 'available', info, error: ipcErrorText(error) })
    } finally {
      finishCommand(command.token)
    }
  }

  const install = async (info: UpdateRef): Promise<void> => {
    const command = beginCommand()
    if (!command) return
    try {
      await window.neoview.installUpdate(command.commandId)
    } catch (error) {
      setLocalFallback(command, { phase: 'ready', info, error: ipcErrorText(error) })
    } finally {
      finishCommand(command.token)
    }
  }

  const dismiss = (): void => {
    const command = beginCommand()
    if (!command) return
    if (state.phase === 'downloading') window.neoview.cancelUpdateDownload(command.commandId)
    else window.neoview.dismissUpdate(command.commandId)
  }

  if (state.phase === 'idle') return null

  return (
    <div className={`notif${state.phase === 'error' ? ' error' : ''}`}>
      {state.phase === 'checking' && <span className="msg">Checking for updates…</span>}
      {state.phase === 'none' && <span className="msg">You’re up to date (v{state.version}).</span>}
      {state.phase === 'error' && <span className="msg">Update check failed: {state.message}</span>}
      {state.phase === 'available' && (
        <>
          <div className="notif-row">
            <span className="msg">Update available: v{state.info.version}</span>
            <button className="notif-action" onClick={() => window.open(state.info.notesUrl)}>
              What’s new
            </button>
          </div>
          {state.error && <div className="notif-detail">{state.error}</div>}
          <div className="notif-row">
            <button
              className="btn primary"
              disabled={commandPending}
              onClick={() => void download(state.info)}
            >
              Download{state.info.assetSize > 0 ? ` (${fmtMB(state.info.assetSize)})` : ''}
            </button>
            <button
              className="notif-action"
              disabled={commandPending}
              onClick={() => {
                const command = beginCommand()
                if (command) window.neoview.skipUpdateVersion(state.info.version, command.commandId)
              }}
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
              {state.total > 0 ? ` / ${fmtMB(state.total)}` : ''}
            </span>
            <button className="notif-action" disabled={commandPending} onClick={dismiss}>
              Cancel
            </button>
          </div>
          <div className="notif-progress">
            <div
              className="fill"
              style={{
                width:
                  state.total > 0 ? `${Math.min(100, (state.received / state.total) * 100)}%` : 0
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
              onClick={() => void install(state.info)}
            >
              {window.neoview.platform === 'darwin'
                ? 'Quit & install'
                : window.neoview.platform === 'linux'
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
        onClick={dismiss}
      >
        ✕
      </button>
    </div>
  )
}
