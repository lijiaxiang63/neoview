/** Pure update-flow payload contracts crossing process boundaries. */

export interface UpdateRef {
  version: string
  notesUrl: string
  assetName: string
  assetSize: number
}

/** Application-owned state. A newly created renderer subscribes first, then
 * queries the current value without letting an older reply overwrite a newer
 * event, so in-flight or completed work survives window recreation. */
export type UpdateState =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'available'; info: UpdateRef; error: string | null }
  | { phase: 'downloading'; info: UpdateRef; received: number; total: number }
  | { phase: 'ready'; info: UpdateRef; error: string | null }
  | { phase: 'saved'; info: UpdateRef }
  | { phase: 'none'; version: string }
  | { phase: 'error'; message: string }

/** Monotonic application-owned snapshot. `revision` orders delivery while
 * renderer commands echo the stable `commandId`, which does not change for
 * progress updates within one operation. */
export interface UpdateSnapshot {
  revision: number
  /** Stable across progress updates; renderer commands target this owner. */
  commandId: number
  state: UpdateState
}

/** IPC payload guard for renderer commands. Command ids are application-owned
 * non-negative safe integers; missing or malformed values must never disable
 * ownership checks at the main-process boundary. */
export function isUpdateCommandId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export interface UpdateInstallResult {
  /** Whether the application is quitting to hand off to the installer. */
  quits: boolean
}
