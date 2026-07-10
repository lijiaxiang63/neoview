/** Pure payload contracts crossing the main/preload/renderer boundary. */

export interface OpenedFile {
  name: string
  path: string
  bytes: ArrayBuffer
}

export interface FolderEntry {
  name: string
  path: string
  /** Directory relative to the scanned root, '/'-joined; '' for the root itself. */
  relDir: string
}

export interface FolderScan {
  root: string
  files: FolderEntry[]
  truncated: boolean
}

export interface FolderScanProgress {
  token: number
  root: string
  files: FolderEntry[]
}

export interface ExportSidecar {
  fileName: string
  text: string
}

export interface ExportRequest {
  /** Target directory; must already exist. */
  dir: string
  fileName: string
  bytes: ArrayBuffer
  /** Optional companion text file written next to the main one. */
  sidecar: ExportSidecar | null
}

export interface ExportResult {
  path: string
  sidecarPath: string | null
}

export interface FilePanelState {
  fileList: boolean
  sidePanel: boolean
  folderOpen: boolean
}
