import { useEffect, useState, type JSX } from 'react'
import type { UpdateProgress, UpdateStatus } from '../../../preload/updates'

const RESULT_MS = 6000

interface UpdateRef {
  version: string
  notesUrl: string
  assetName: string
  assetSize: number
}

type Phase =
  | { p: 'checking' }
  | { p: 'available'; info: UpdateRef; error: string | null }
  | { p: 'downloading'; info: UpdateRef; received: number; total: number }
  | { p: 'ready'; info: UpdateRef }
  /** Linux: file revealed in the file manager, updating is manual from here. */
  | { p: 'saved'; info: UpdateRef }
  | { p: 'none'; version: string }
  | { p: 'error'; message: string }

function fmtMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Drop the "Error invoking remote method ..." wrapper IPC errors carry. */
function ipcErrorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : 'Download failed.'
  return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/** The update lifecycle rendered as a notification card. Persistent phases
 * (available / downloading / ready) stay until resolved; result phases dismiss
 * themselves. Always mounted inside the notification stack so it keeps
 * receiving IPC events. */
export function UpdateNotif(): JSX.Element | null {
  const [phase, setPhase] = useState<Phase | null>(null)

  useEffect(() => {
    const offStatus = window.neoview.onUpdateStatus((status: UpdateStatus) => {
      setPhase((cur) => {
        // A download in flight (or done) outranks new check chatter, unless a
        // different version shows up.
        const busy = cur && (cur.p === 'downloading' || cur.p === 'ready' || cur.p === 'saved')
        if (busy && !(status.kind === 'available' && status.version !== cur.info.version)) {
          return cur
        }
        if (status.kind === 'checking') return { p: 'checking' }
        if (status.kind === 'available') {
          const { version, notesUrl, assetName, assetSize } = status
          return { p: 'available', info: { version, notesUrl, assetName, assetSize }, error: null }
        }
        if (status.kind === 'none') return { p: 'none', version: status.version }
        return { p: 'error', message: status.message }
      })
    })
    const offProgress = window.neoview.onUpdateProgress((progress: UpdateProgress) => {
      setPhase((cur) => (cur && cur.p === 'downloading' ? { ...cur, ...progress } : cur))
    })
    return () => {
      offStatus()
      offProgress()
    }
  }, [])

  // Transient results dismiss themselves like a toast.
  useEffect(() => {
    if (!phase || (phase.p !== 'none' && phase.p !== 'error' && phase.p !== 'saved')) return
    const t = setTimeout(() => setPhase(null), RESULT_MS)
    return () => clearTimeout(t)
  }, [phase])

  const download = async (info: UpdateRef): Promise<void> => {
    setPhase({ p: 'downloading', info, received: 0, total: info.assetSize })
    try {
      const path = await window.neoview.downloadUpdate()
      if (path) setPhase({ p: 'ready', info })
      else setPhase(null) // cancelled
    } catch (err) {
      setPhase({ p: 'available', info, error: ipcErrorText(err) })
    }
  }

  const install = async (info: UpdateRef): Promise<void> => {
    // On mac/win the app quits and hands off to the installer; if unsaved
    // region edits veto the quit, the banner simply stays on 'ready'.
    const { quits } = await window.neoview.installUpdate()
    if (!quits) setPhase({ p: 'saved', info })
  }

  const dismiss = (): void => {
    if (phase?.p === 'downloading') window.neoview.cancelUpdateDownload()
    setPhase(null)
  }

  if (!phase) return null

  return (
    <div className={`notif${phase.p === 'error' ? ' error' : ''}`}>
      {phase.p === 'checking' && <span className="msg">Checking for updates…</span>}
      {phase.p === 'none' && <span className="msg">You’re up to date (v{phase.version}).</span>}
      {phase.p === 'error' && <span className="msg">Update check failed: {phase.message}</span>}
      {phase.p === 'available' && (
        <>
          <div className="notif-row">
            <span className="msg">Update available: v{phase.info.version}</span>
            <button className="notif-action" onClick={() => window.open(phase.info.notesUrl)}>
              What’s new
            </button>
          </div>
          {phase.error && <div className="notif-detail">{phase.error}</div>}
          <div className="notif-row">
            <button className="btn primary" onClick={() => void download(phase.info)}>
              Download{phase.info.assetSize > 0 ? ` (${fmtMB(phase.info.assetSize)})` : ''}
            </button>
            <button
              className="notif-action"
              onClick={() => {
                window.neoview.skipUpdateVersion(phase.info.version)
                setPhase(null)
              }}
            >
              Skip this version
            </button>
          </div>
        </>
      )}
      {phase.p === 'downloading' && (
        <>
          <div className="notif-row">
            <span className="msg">
              Downloading v{phase.info.version}… {fmtMB(phase.received)}
              {phase.total > 0 ? ` / ${fmtMB(phase.total)}` : ''}
            </span>
            <button className="notif-action" onClick={() => window.neoview.cancelUpdateDownload()}>
              Cancel
            </button>
          </div>
          <div className="notif-progress">
            <div
              className="fill"
              style={{
                width:
                  phase.total > 0 ? `${Math.min(100, (phase.received / phase.total) * 100)}%` : 0
              }}
            />
          </div>
        </>
      )}
      {phase.p === 'ready' && (
        <div className="notif-row">
          <span className="msg">v{phase.info.version} downloaded.</span>
          <button className="btn primary" onClick={() => void install(phase.info)}>
            {window.neoview.platform === 'darwin' ? 'Quit & install' : 'Restart to install'}
          </button>
        </div>
      )}
      {phase.p === 'saved' && (
        <span className="msg">Installer saved — run it to finish updating.</span>
      )}
      <button className="notif-close" aria-label="Dismiss" onClick={dismiss}>
        ✕
      </button>
    </div>
  )
}
