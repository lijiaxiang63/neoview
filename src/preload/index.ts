import { contextBridge, ipcRenderer, webUtils } from 'electron'

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
  confirmClose: (): void => ipcRenderer.send('close-confirmed')
}

export type NeoviewApi = typeof api

contextBridge.exposeInMainWorld('neoview', api)
