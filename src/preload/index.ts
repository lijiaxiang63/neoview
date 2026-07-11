import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  ExportRequest,
  ExportResult,
  FilePanelState,
  FolderEntry,
  FolderScan,
  FolderScanProgress,
  OpenedFile
} from '../shared/files'
import type { UpdateInstallResult, UpdateSnapshot } from '../shared/updates'
import { applyStorageOriginMigration, storageMigrationStep } from '../shared/storageMigration'

export type {
  ExportRequest,
  ExportResult,
  FilePanelState,
  FolderEntry,
  FolderScan,
  FolderScanProgress,
  OpenedFile
} from '../shared/files'
export type { UpdateInstallResult, UpdateSnapshot } from '../shared/updates'

// Packaged builds moved from a file origin to a secure custom origin. Main
// reads the former origin once in a hidden page; preload copies only the
// fixed preference keys before application code starts.
if (window.location.protocol === 'app:') {
  const migrationStep = storageMigrationStep(window.localStorage)
  if (migrationStep === 'migrate') {
    const snapshot: unknown = ipcRenderer.sendSync('storage-migration-read')
    if (applyStorageOriginMigration(window.localStorage, snapshot)) {
      ipcRenderer.send('storage-migration-applied')
    }
  } else if (migrationStep === 'acknowledge') {
    // The prior acknowledgement or disk-marker write may have been lost.
    // Repeating it is idempotent and lets main complete the second phase.
    ipcRenderer.send('storage-migration-applied')
  }
}

const api = {
  openDialog: (baseIntent: number): Promise<OpenedFile | null> =>
    ipcRenderer.invoke('open-dialog', baseIntent),
  /** Overlay picker/read owned by a renderer request id. Base replacement,
   * runtime disposal, or document teardown can cancel it through the same
   * read-cancellation channel used by folder navigation. */
  openOverlayDialog: (requestId: number): Promise<OpenedFile | null> =>
    ipcRenderer.invoke('open-overlay-dialog', requestId),
  /** Reserve ordering before renderer-side path probes or reads begin. */
  beginBaseIntent: (): Promise<number> => ipcRenderer.invoke('begin-base-intent'),
  /** Promote a provisional token once its operation has a real result. Main
   * can then abort older disk work before it allocates or crosses IPC. */
  acceptBaseIntent: (intent: number): void => ipcRenderer.send('accept-base-intent', intent),
  onFileOpened: (cb: (intent: number, file: OpenedFile) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, intent: number, file: OpenedFile): void =>
      cb(intent, file)
    ipcRenderer.on('file-opened', listener)
    return () => ipcRenderer.removeListener('file-opened', listener)
  },
  /** Bind a main-side overlay read to the base session visible at its start. */
  onOverlayOpenStarted: (cb: (openId: number) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, openId: number): void => cb(openId)
    ipcRenderer.on('overlay-open-started', listener)
    return () => ipcRenderer.removeListener('overlay-open-started', listener)
  },
  onOverlayOpened: (cb: (openId: number, file: OpenedFile) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, openId: number, file: OpenedFile): void =>
      cb(openId, file)
    ipcRenderer.on('overlay-opened', listener)
    return () => ipcRenderer.removeListener('overlay-opened', listener)
  },
  onOverlayOpenError: (cb: (openId: number, message: string) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, openId: number, message: string): void =>
      cb(openId, message)
    ipcRenderer.on('overlay-open-error', listener)
    return () => ipcRenderer.removeListener('overlay-open-error', listener)
  },
  onFileOpenError: (cb: (message: string, intent?: number) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, message: string, intent?: number): void =>
      cb(message, intent)
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
    const listener = (_e: Electron.IpcRendererEvent, msg: FolderScanProgress): void =>
      cb(msg.token, msg.root, msg.files)
    ipcRenderer.on('scan-folder-progress', listener)
    return () => ipcRenderer.removeListener('scan-folder-progress', listener)
  },
  /** File > Open Folder… was chosen; the renderer runs the picker + scan flow. */
  onOpenFolderRequest: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('open-folder-request', listener)
    return () => ipcRenderer.removeListener('open-folder-request', listener)
  },
  /** Help > Keyboard Shortcuts was chosen in the menu. */
  onShowShortcuts: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('show-shortcuts', listener)
    return () => ipcRenderer.removeListener('show-shortcuts', listener)
  },
  /** Edit > Undo / Redo (the renderer decides between a text-field undo and
   * a region-edit undo). */
  onMenuUndo: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('menu-undo', listener)
    return () => ipcRenderer.removeListener('menu-undo', listener)
  },
  onMenuRedo: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('menu-redo', listener)
    return () => ipcRenderer.removeListener('menu-redo', listener)
  },
  /** A base volume from this path was opened; feeds the Open Recent menu. */
  noteFileOpened: (path: string): void => ipcRenderer.send('note-file-opened', path),
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
  sendViewState: (state: FilePanelState): void => ipcRenderer.send('view-state', state),
  /** Read one file from inside a previously opened folder. */
  readFile: (path: string, requestId: number): Promise<OpenedFile> =>
    ipcRenderer.invoke('read-file', path, requestId),
  /** Read a folder file only when its size is within maxBytes; null otherwise
   * (the size gate runs main-side, before any bytes cross the boundary). */
  readFileWithin: (path: string, maxBytes: number, requestId: number): Promise<OpenedFile | null> =>
    ipcRenderer.invoke('read-file-limited', path, maxBytes, requestId),
  /** Stop an obsolete folder read without waiting for its bytes to finish. */
  cancelFileRead: (requestId: number): void => ipcRenderer.send('cancel-file-read', requestId),
  /** Confirm that this scan's root has become the renderer's current folder. */
  confirmFolderScan: (token: number): void => ipcRenderer.send('confirm-folder-scan', token),
  /** Invalidate the matching scan; late cancellation of an older token is ignored. */
  cancelFolderScan: (token: number): void => ipcRenderer.send('cancel-folder-scan', token),
  /** The displayed folder closed; its read authorization is no longer needed. */
  releaseFolderAccess: (): void => ipcRenderer.send('release-folder-access'),
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
  onCloseRequested: (cb: (requestId: number, responderLease: number) => void): (() => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      requestId: number,
      responderLease: number
    ): void => cb(requestId, responderLease)
    ipcRenderer.on('close-requested', listener)
    return () => ipcRenderer.removeListener('close-requested', listener)
  },
  claimCloseResponder: (): Promise<number> => ipcRenderer.invoke('close-responder-claim'),
  activateCloseResponder: (lease: number): void =>
    ipcRenderer.send('close-responder-activate', lease),
  releaseCloseResponder: (lease: number): void =>
    ipcRenderer.send('close-responder-release', lease),
  confirmClose: (requestId: number, lease: number): void =>
    ipcRenderer.send('close-confirmed', requestId, lease),
  cancelClose: (requestId: number, lease: number): void =>
    ipcRenderer.send('close-cancelled', requestId, lease),
  platform: process.platform,
  getUpdateState: (): Promise<UpdateSnapshot> => ipcRenderer.invoke('update-state'),
  onUpdateState: (cb: (snapshot: UpdateSnapshot) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, snapshot: UpdateSnapshot): void => cb(snapshot)
    ipcRenderer.on('update-state', listener)
    return () => ipcRenderer.removeListener('update-state', listener)
  },
  /** Resolves with the downloaded installer path, or null when cancelled. */
  downloadUpdate: (commandId: number): Promise<string | null> =>
    ipcRenderer.invoke('update-download', commandId),
  cancelUpdateDownload: (commandId: number): void =>
    ipcRenderer.send('update-download-cancel', commandId),
  /** quits=true means the app is quitting to hand off to the installer. */
  installUpdate: (commandId: number): Promise<UpdateInstallResult> =>
    ipcRenderer.invoke('update-install', commandId),
  skipUpdateVersion: (version: string, commandId: number): void =>
    ipcRenderer.send('update-skip', version, commandId),
  dismissUpdate: (commandId: number): void => ipcRenderer.send('update-dismiss', commandId)
}

export type NeoviewApi = typeof api

contextBridge.exposeInMainWorld('neoview', api)
