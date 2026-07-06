import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { UpdateProgress, UpdateStatus } from './updates'

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
  /** A bundled sample overlay was chosen from the menu; route it to a layer. */
  onOverlayOpened: (cb: (file: OpenedFile) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, file: OpenedFile): void => cb(file)
    ipcRenderer.on('overlay-opened', listener)
    return () => ipcRenderer.removeListener('overlay-opened', listener)
  },
  onFileOpenError: (cb: (message: string) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, message: string): void => cb(message)
    ipcRenderer.on('file-open-error', listener)
    return () => ipcRenderer.removeListener('file-open-error', listener)
  },
  /** Directory picker + recursive scan, both owned by the main process. The
   * token is echoed in every progress batch so the caller can drop batches
   * from superseded scans. */
  openFolderScan: (token: number): Promise<FolderScan | null> =>
    ipcRenderer.invoke('open-folder-scan', token),
  /** Whether a path names a directory (read-only probe, registers nothing). */
  isDirectory: (path: string): Promise<boolean> => ipcRenderer.invoke('is-directory', path),
  /**
   * Scan a dropped directory for volume files; null when the drop is not a
   * directory. The path is derived here from the File object itself — page
   * script cannot mint a File with an on-disk path, so only genuine drops
   * (or picks) can register a scan root.
   */
  scanDroppedFolder: (file: File, token: number): Promise<FolderScan | null> => {
    let path = ''
    try {
      path = webUtils.getPathForFile(file)
    } catch {
      return Promise.resolve(null)
    }
    if (!path) return Promise.resolve(null)
    return ipcRenderer.invoke('scan-folder', path, token)
  },
  /** Batches of files found while a scan-folder call is still running. */
  onScanFolderProgress: (
    cb: (token: number, root: string, files: FolderEntry[]) => void
  ): (() => void) => {
    const listener = (
      _e: Electron.IpcRendererEvent,
      msg: { token: number; root: string; files: FolderEntry[] }
    ): void => cb(msg.token, msg.root, msg.files)
    ipcRenderer.on('scan-folder-progress', listener)
    return () => ipcRenderer.removeListener('scan-folder-progress', listener)
  },
  /** File > Open Folder… was chosen; the renderer runs the picker + scan flow. */
  onOpenFolderRequest: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('open-folder-request', listener)
    return () => ipcRenderer.removeListener('open-folder-request', listener)
  },
  /** View > File List was chosen in the menu. */
  onToggleFilePanel: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('toggle-file-panel', listener)
    return () => ipcRenderer.removeListener('toggle-file-panel', listener)
  },
  /** View > Side Panel was chosen in the menu. */
  onToggleSidePanel: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('toggle-side-panel', listener)
    return () => ipcRenderer.removeListener('toggle-side-panel', listener)
  },
  /** Mirror panel visibility to the View menu's checkbox items. */
  sendViewState: (state: { fileList: boolean; sidePanel: boolean; folderOpen: boolean }): void =>
    ipcRenderer.send('view-state', state),
  /** Read one file from inside a previously opened folder. */
  readFile: (path: string): Promise<OpenedFile> => ipcRenderer.invoke('read-file', path),
  /** Read a folder file only when its size is within maxBytes; null otherwise
   * (the size gate runs main-side, before any bytes cross the boundary). */
  readFileWithin: (path: string, maxBytes: number): Promise<OpenedFile | null> =>
    ipcRenderer.invoke('read-file-limited', path, maxBytes),
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
  /**
   * Window close was requested; reply with confirmClose() to let it through,
   * or cancelClose() when the user declines so the main process can stand down.
   */
  onCloseRequested: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('close-requested', listener)
    return () => ipcRenderer.removeListener('close-requested', listener)
  },
  confirmClose: (): void => ipcRenderer.send('close-confirmed'),
  cancelClose: (): void => ipcRenderer.send('close-cancelled'),
  platform: process.platform,
  onUpdateStatus: (cb: (status: UpdateStatus) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, status: UpdateStatus): void => cb(status)
    ipcRenderer.on('update-status', listener)
    return () => ipcRenderer.removeListener('update-status', listener)
  },
  onUpdateProgress: (cb: (progress: UpdateProgress) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, progress: UpdateProgress): void => cb(progress)
    ipcRenderer.on('update-progress', listener)
    return () => ipcRenderer.removeListener('update-progress', listener)
  },
  /** Resolves with the downloaded installer path, or null when cancelled. */
  downloadUpdate: (): Promise<string | null> => ipcRenderer.invoke('update-download'),
  cancelUpdateDownload: (): void => ipcRenderer.send('update-download-cancel'),
  /** quits=true means the app is quitting to hand off to the installer. */
  installUpdate: (): Promise<{ quits: boolean }> => ipcRenderer.invoke('update-install'),
  skipUpdateVersion: (version: string): void => ipcRenderer.send('update-skip', version)
}

export type NeoviewApi = typeof api

contextBridge.exposeInMainWorld('neoview', api)
