/** Pure payload contracts crossing the main/preload/renderer boundary. */

export const FILE_CHANNELS = {
  openDialog: 'open-dialog',
  openOverlayDialog: 'open-overlay-dialog',
  openFolderScan: 'open-folder-scan',
  isDirectory: 'is-directory',
  scanFolder: 'scan-folder',
  scanFolderProgress: 'scan-folder-progress',
  readFile: 'read-file',
  readFileLimited: 'read-file-limited',
  cancelFileRead: 'cancel-file-read',
  confirmFolderScan: 'confirm-folder-scan',
  cancelFolderScan: 'cancel-folder-scan',
  releaseFolderAccess: 'release-folder-access',
  exportFile: 'export-file',
  pickDirectory: 'pick-directory',
  revealInFolder: 'reveal-in-folder',
  noteFileOpened: 'note-file-opened'
} as const

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

export function parseExportRequest(value: unknown): ExportRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid export request.')
  }
  const request = value as Record<string, unknown>
  const sidecar = request.sidecar
  if (
    typeof request.dir !== 'string' ||
    typeof request.fileName !== 'string' ||
    !(request.bytes instanceof ArrayBuffer) ||
    !(
      sidecar === null ||
      (typeof sidecar === 'object' &&
        sidecar !== null &&
        !Array.isArray(sidecar) &&
        typeof (sidecar as Record<string, unknown>).fileName === 'string' &&
        typeof (sidecar as Record<string, unknown>).text === 'string')
    )
  ) {
    throw new Error('Invalid export request.')
  }
  return {
    dir: request.dir,
    fileName: request.fileName,
    bytes: request.bytes,
    sidecar:
      sidecar === null
        ? null
        : {
            fileName: (sidecar as Record<string, string>).fileName,
            text: (sidecar as Record<string, string>).text
          }
  }
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
