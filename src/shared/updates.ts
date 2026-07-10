/** Pure update-flow payload contracts crossing process boundaries. */

export type UpdateStatus =
  | { kind: 'checking'; manual: boolean }
  | {
      kind: 'available'
      manual: boolean
      version: string
      notesUrl: string
      assetName: string
      assetSize: number
    }
  | { kind: 'none'; manual: boolean; version: string }
  | { kind: 'error'; manual: boolean; message: string }

export interface UpdateProgress {
  received: number
  total: number
}

export interface UpdateInstallResult {
  /** Whether the application is quitting to hand off to the installer. */
  quits: boolean
}
