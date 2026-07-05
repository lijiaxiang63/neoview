import { contextBridge, ipcRenderer } from 'electron'

export interface OpenedFile {
  name: string
  bytes: ArrayBuffer
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
  }
}

export type NeoviewApi = typeof api

contextBridge.exposeInMainWorld('neoview', api)
