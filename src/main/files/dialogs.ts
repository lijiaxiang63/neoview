import type { BrowserWindow, OpenDialogOptions, OpenDialogReturnValue } from 'electron'
import type { OpenedFile } from '../../shared/files'
import type { FileReader } from './reader'

export interface FileDialogDependencies {
  showOpenDialog(window: BrowserWindow, options: OpenDialogOptions): Promise<OpenDialogReturnValue>
}

export interface FileDialogs {
  /** Keep the selected path on the main side so callers can establish read
   * ownership after a non-null pick but before any bytes are allocated. */
  pickFilePath(window: BrowserWindow): Promise<string | null>
  pickAndRead(window: BrowserWindow, signal?: AbortSignal): Promise<OpenedFile | null>
  pickScanRoot(window: BrowserWindow): Promise<string | null>
  pickExportDirectory(window: BrowserWindow): Promise<string | null>
}

function selectedPath(result: OpenDialogReturnValue): string | null {
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
}

export function createFileDialogs(deps: FileDialogDependencies, reader: FileReader): FileDialogs {
  const pickFilePath = async (window: BrowserWindow): Promise<string | null> =>
    selectedPath(
      await deps.showOpenDialog(window, {
        properties: ['openFile'],
        filters: [
          { name: 'Volume files', extensions: ['nii', 'nii.gz'] },
          { name: 'All files', extensions: ['*'] }
        ]
      })
    )

  return {
    pickFilePath,

    async pickAndRead(window, signal) {
      const path = await pickFilePath(window)
      return path === null ? null : reader.read(path, path, signal)
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
