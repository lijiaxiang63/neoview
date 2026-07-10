import type { BrowserWindow, OpenDialogOptions, OpenDialogReturnValue } from 'electron'
import type { OpenedFile } from '../../shared/files'
import type { FileReader } from './reader'

export interface FileDialogDependencies {
  showOpenDialog(window: BrowserWindow, options: OpenDialogOptions): Promise<OpenDialogReturnValue>
}

export interface FileDialogs {
  pickAndRead(window: BrowserWindow): Promise<OpenedFile | null>
  pickScanRoot(window: BrowserWindow): Promise<string | null>
  pickExportDirectory(window: BrowserWindow): Promise<string | null>
}

function selectedPath(result: OpenDialogReturnValue): string | null {
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
}

export function createFileDialogs(deps: FileDialogDependencies, reader: FileReader): FileDialogs {
  return {
    async pickAndRead(window) {
      const result = await deps.showOpenDialog(window, {
        properties: ['openFile'],
        filters: [
          { name: 'Volume files', extensions: ['nii', 'nii.gz', 'gz'] },
          { name: 'All files', extensions: ['*'] }
        ]
      })
      const path = selectedPath(result)
      return path === null ? null : reader.read(path)
    },

    async pickScanRoot(window) {
      return selectedPath(await deps.showOpenDialog(window, { properties: ['openDirectory'] }))
    },

    async pickExportDirectory(window) {
      return selectedPath(
        await deps.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] })
      )
    }
  }
}
