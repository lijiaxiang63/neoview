import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { UpdateProgress, UpdateStatus } from './updates'

export interface OpenedFile {
  name: string
  path: string
  bytes: ArrayBuffer
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
  confirmClose: (): void => ipcRenderer.send('close-confirmed'),
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
