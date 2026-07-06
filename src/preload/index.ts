import { contextBridge, ipcRenderer, webUtils } from 'electron'

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

export interface ExportRequest {
  dir: string
  fileName: string
  bytes: ArrayBuffer
  sidecar: { fileName: string; text: string } | null
}

export interface ExportResult {
  path: string
  sidecarPath: string | null
}

const api = {
  openDialog: (): Promise<OpenedFile | null> => ipcRenderer.invoke('open-dialog'),
  onFileOpened: (cb: (file: OpenedFile) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, file: OpenedFile): void => cb(file)
    ipcRenderer.on('file-opened', listener)
    return () => ipcRenderer.removeListener('file-opened', listener)
  },
  onFileOpenError: (cb: (message: string) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, message: string): void => cb(message)
    ipcRenderer.on('file-open-error', listener)
    return () => ipcRenderer.removeListener('file-open-error', listener)
  },
  /** Directory picker + recursive scan, both owned by the main process. */
  openFolderScan: (): Promise<FolderScan | null> => ipcRenderer.invoke('open-folder-scan'),
  /** Whether a path names a directory (read-only probe, registers nothing). */
  isDirectory: (path: string): Promise<boolean> => ipcRenderer.invoke('is-directory', path),
  /**
   * Scan a dropped directory for volume files; null when the drop is not a
   * directory. The path is derived here from the File object itself — page
   * script cannot mint a File with an on-disk path, so only genuine drops
   * (or picks) can register a scan root.
   */
  scanDroppedFolder: (file: File): Promise<FolderScan | null> => {
    let path = ''
    try {
      path = webUtils.getPathForFile(file)
    } catch {
      return Promise.resolve(null)
    }
    if (!path) return Promise.resolve(null)
    return ipcRenderer.invoke('scan-folder', path)
  },
  /** Batches of files found while a scan-folder call is still running. */
  onScanFolderProgress: (cb: (root: string, files: FolderEntry[]) => void): (() => void) => {
    const listener = (
      _e: Electron.IpcRendererEvent,
      msg: { root: string; files: FolderEntry[] }
    ): void => cb(msg.root, msg.files)
    ipcRenderer.on('scan-folder-progress', listener)
    return () => ipcRenderer.removeListener('scan-folder-progress', listener)
  },
  /** File > Open Folder… was chosen; the renderer runs the picker + scan flow. */
  onOpenFolderRequest: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('open-folder-request', listener)
    return () => ipcRenderer.removeListener('open-folder-request', listener)
  },
  /** Read one file from inside a previously opened folder. */
  readFile: (path: string): Promise<OpenedFile> => ipcRenderer.invoke('read-file', path),
  /** Absolute path of a dropped File ('' when unavailable). */
  pathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  exportFile: (req: ExportRequest): Promise<ExportResult> => ipcRenderer.invoke('export-file', req),
  pickDirectory: (): Promise<string | null> => ipcRenderer.invoke('pick-directory'),
  revealInFolder: (path: string): void => ipcRenderer.send('reveal-in-folder', path),
  /** Window close was requested; reply with confirmClose() to let it through. */
  onCloseRequested: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('close-requested', listener)
    return () => ipcRenderer.removeListener('close-requested', listener)
  },
  confirmClose: (): void => ipcRenderer.send('close-confirmed')
}

export type NeoviewApi = typeof api

contextBridge.exposeInMainWorld('neoview', api)
