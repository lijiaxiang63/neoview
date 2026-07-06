/** Update-flow payloads shared by main, preload, and renderer (types only). */

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
