import type {
  BrowserWindow,
  IpcMain,
  IpcMainEvent,
  IpcMainInvokeEvent,
  WebContents
} from 'electron'
import {
  FILE_CHANNELS,
  parseExportRequest,
  type FolderScan,
  type FolderScanProgress
} from '../../shared/files'
import type { OpenedLayerTable } from '../../shared/files'
import type { FileAccessAuthorizer, ScanAccessRequest } from './access'
import type { FileDialogs } from './dialogs'
import type { ExportService } from './exports'
import { isVolumeFileName } from './names'
import type { FileReader } from './reader'
import type { FolderScanner } from './scanner'
import type { OpenJobCoordinator } from '../openJobs'
import type { RendererMainFrameGate } from '../rendererProtocol'
import { FileSenderSessionRegistry } from './sessionRegistry'

const LAYER_TABLE_MAX_BYTES = 8 * 1024 * 1024

function isTableFileName(path: string): boolean {
  return path.toLowerCase().endsWith('.txt')
}

function companionTablePath(path: string): string {
  return path.replace(/(\.nii\.gz|\.nii)$/i, '.txt')
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

async function readLayerTable(
  reader: FileReader,
  path: string,
  signal: AbortSignal
): Promise<OpenedLayerTable> {
  const opened = await reader.readWithin(path, LAYER_TABLE_MAX_BYTES, path, signal)
  if (!opened) throw new Error('Layer table is larger than 8 MB, which is not supported.')
  return {
    name: opened.name,
    path: opened.path,
    text: new TextDecoder().decode(opened.bytes)
  }
}

export interface FileIpcDependencies {
  ipc: Pick<IpcMain, 'handle' | 'removeHandler' | 'on' | 'removeListener'>
  access: FileAccessAuthorizer
  dialogs: FileDialogs
  builtInLayerTablePath: string
  reader: FileReader
  scanner: FolderScanner
  exporter: ExportService
  openJobs: OpenJobCoordinator<WebContents>
  isTrustedMainFrame: RendererMainFrameGate
  windowFromSender(sender: WebContents): BrowserWindow | null
  isDirectory(path: string): Promise<boolean>
  revealInFolder(path: string): void
  noteFileOpened(path: string): void
}

type InvokeHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
type EventHandler = (event: IpcMainEvent, ...args: unknown[]) => void
/**
 * Register every file-related channel as one disposable unit. Dependencies
 * are explicit, and a failed/duplicate registration rolls back prior work.
 */
export function registerFileIpc(deps: FileIpcDependencies): () => void {
  const handleChannels: string[] = []
  const eventHandlers: Array<{ channel: string; handler: EventHandler }> = []
  const sessions = new FileSenderSessionRegistry(deps.access)
  let disposed = false

  const isCurrentMainFrame = (event: IpcMainEvent | IpcMainInvokeEvent): boolean =>
    deps.isTrustedMainFrame(event)

  const requireCurrentMainFrame = (event: IpcMainInvokeEvent): void => {
    if (!isCurrentMainFrame(event)) throw new Error('File operation is unavailable.')
  }

  const removeInstalled = (): void => {
    for (const channel of handleChannels) deps.ipc.removeHandler(channel)
    handleChannels.length = 0
    for (const { channel, handler } of eventHandlers) deps.ipc.removeListener(channel, handler)
    eventHandlers.length = 0
    sessions.dispose()
  }

  const addHandle = (channel: string, handler: InvokeHandler): void => {
    deps.ipc.handle(channel, handler)
    handleChannels.push(channel)
  }

  const addListener = (channel: string, handler: EventHandler): void => {
    deps.ipc.on(channel, handler)
    eventHandlers.push({ channel, handler })
  }

  const scanAndStream = async (
    sender: WebContents,
    path: string,
    token: number,
    request: ScanAccessRequest
  ): Promise<FolderScan | null> => {
    if (!(await deps.isDirectory(path))) return null
    const prepared = await deps.access.prepareScan(request, path)
    if (prepared === null) return null
    let activated = false
    const activateCurrent = (): boolean => {
      if (!deps.access.isCurrent(prepared)) return false
      if (!activated) {
        activated = deps.access.activateScan(prepared)
        if (activated && !deps.openJobs.accept(token)) {
          deps.access.cancelScan(sender.id)
          activated = false
        }
      }
      return activated
    }
    const scan = await deps.scanner.scan(
      path,
      (files) => {
        // Authorization changes before the batch crosses the boundary, so every
        // path the renderer can display is readable immediately.
        if (!activateCurrent()) return
        if (sender.isDestroyed()) {
          sessions.releaseOwner(sender.id)
          return
        }
        const progress: FolderScanProgress = { token, root: path, files }
        sender.send(FILE_CHANNELS.scanFolderProgress, progress)
      },
      () => !disposed && !sender.isDestroyed() && deps.access.isCurrent(prepared)
    )
    if (!activateCurrent() || sender.isDestroyed()) {
      if (sender.isDestroyed()) sessions.releaseOwner(sender.id)
      return null
    }
    return scan
  }

  const tokenOf = (token: unknown): number => (typeof token === 'number' ? token : 0)

  const readIdOf = (value: unknown): number => {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
    throw new Error('Invalid file read request.')
  }

  try {
    addHandle(FILE_CHANNELS.openDialog, async (event, intentValue: unknown) => {
      requireCurrentMainFrame(event)
      const window = deps.windowFromSender(event.sender)
      if (!window) return null
      if (
        typeof intentValue !== 'number' ||
        !Number.isSafeInteger(intentValue) ||
        intentValue <= 0
      ) {
        throw new Error('Invalid base-open intent.')
      }

      const scope = deps.openJobs.capture(event.sender)
      let path: string | null
      try {
        path = await deps.dialogs.pickFilePath(window)
      } catch (error) {
        if (isCurrentMainFrame(event) && deps.openJobs.scopeIsCurrent(scope)) {
          deps.openJobs.accept(intentValue)
          throw error
        }
        return null
      }
      if (path === null || !isCurrentMainFrame(event) || !deps.openJobs.scopeIsCurrent(scope)) {
        return null
      }
      const job = deps.openJobs.begin(intentValue, scope)
      if (!job) return null
      try {
        const opened = await deps.reader.read(path, path, job.signal)
        return deps.openJobs.isCurrent(job) && isCurrentMainFrame(event) ? opened : null
      } catch (error) {
        if (!deps.openJobs.isCurrent(job) || !isCurrentMainFrame(event)) return null
        if (!deps.openJobs.accept(intentValue)) return null
        throw error
      } finally {
        deps.openJobs.finish(job)
      }
    })

    addHandle(
      FILE_CHANNELS.openOverlayDialog,
      async (event, requestIdValue: unknown, currentFilePathValue?: unknown) => {
        requireCurrentMainFrame(event)
        const window = deps.windowFromSender(event.sender)
        if (!window) return null
        sessions.track(event.sender)
        const requestId = readIdOf(requestIdValue)
        const abort = sessions.beginRead(event.sender.id, requestId)
        try {
          const currentFilePath =
            typeof currentFilePathValue === 'string' && currentFilePathValue !== ''
              ? currentFilePathValue
              : null
          const path = await deps.dialogs.pickLayerPath(window, currentFilePath)
          if (path === null || abort.signal.aborted || !isCurrentMainFrame(event)) return null
          if (isTableFileName(path)) {
            const table = await readLayerTable(deps.reader, path, abort.signal)
            return !abort.signal.aborted && isCurrentMainFrame(event)
              ? { kind: 'table' as const, table }
              : null
          }
          if (!isVolumeFileName(path)) throw new Error('Select a .nii, .nii.gz, or .txt file.')
          const file = await deps.reader.read(path, path, abort.signal)
          let table: OpenedLayerTable | null = null
          let tableError: string | null = null
          try {
            table = await readLayerTable(deps.reader, companionTablePath(path), abort.signal)
          } catch (error) {
            if (!isMissingFile(error)) {
              tableError =
                error instanceof Error ? error.message : 'Could not read the layer table.'
            }
          }
          return !abort.signal.aborted && isCurrentMainFrame(event)
            ? { kind: 'volume' as const, file, table, tableError }
            : null
        } catch (error) {
          if (abort.signal.aborted || !isCurrentMainFrame(event)) return null
          throw error
        } finally {
          sessions.finishRead(event.sender.id, requestId, abort)
        }
      }
    )

    addHandle(
      FILE_CHANNELS.openLayerTable,
      async (event, requestIdValue: unknown, currentFilePathValue?: unknown) => {
        requireCurrentMainFrame(event)
        const window = deps.windowFromSender(event.sender)
        if (!window) return null
        sessions.track(event.sender)
        const requestId = readIdOf(requestIdValue)
        const abort = sessions.beginRead(event.sender.id, requestId)
        try {
          const currentFilePath =
            typeof currentFilePathValue === 'string' && currentFilePathValue !== ''
              ? currentFilePathValue
              : null
          const path = await deps.dialogs.pickLayerTablePath(window, currentFilePath)
          if (path === null || abort.signal.aborted || !isCurrentMainFrame(event)) return null
          if (!isTableFileName(path)) throw new Error('Select a .txt file.')
          const table = await readLayerTable(deps.reader, path, abort.signal)
          return !abort.signal.aborted && isCurrentMainFrame(event) ? table : null
        } catch (error) {
          if (abort.signal.aborted || !isCurrentMainFrame(event)) return null
          throw error
        } finally {
          sessions.finishRead(event.sender.id, requestId, abort)
        }
      }
    )

    addHandle(FILE_CHANNELS.readBuiltInLayerTable, async (event, requestIdValue: unknown) => {
      requireCurrentMainFrame(event)
      sessions.track(event.sender)
      const requestId = readIdOf(requestIdValue)
      const abort = sessions.beginRead(event.sender.id, requestId)
      try {
        const table = await readLayerTable(deps.reader, deps.builtInLayerTablePath, abort.signal)
        return !abort.signal.aborted && isCurrentMainFrame(event)
          ? { ...table, name: 'FreeSurferColorLUT.txt', path: '' }
          : null
      } catch (error) {
        if (abort.signal.aborted || !isCurrentMainFrame(event)) return null
        throw error
      } finally {
        sessions.finishRead(event.sender.id, requestId, abort)
      }
    })

    addHandle(FILE_CHANNELS.openFolderScan, async (event, token: unknown) => {
      requireCurrentMainFrame(event)
      const window = deps.windowFromSender(event.sender)
      if (!window) return null
      sessions.track(event.sender)
      const scanToken = tokenOf(token)
      const request = sessions.beginScan(event.sender, scanToken)
      try {
        const path = await deps.dialogs.pickScanRoot(window)
        if (path === null) {
          sessions.finishScan(event.sender.id, request, false)
          return null
        }
        const result = await scanAndStream(event.sender, path, scanToken, request)
        sessions.finishScan(event.sender.id, request, result !== null)
        return result
      } catch (error) {
        sessions.finishScan(event.sender.id, request, false)
        throw error
      }
    })

    // Read-only metadata probe; it changes no authorization state.
    addHandle(FILE_CHANNELS.isDirectory, async (_event, path: unknown) => {
      requireCurrentMainFrame(_event)
      return typeof path === 'string' && path !== '' ? deps.isDirectory(path) : false
    })

    addHandle(FILE_CHANNELS.scanFolder, async (event, path: unknown, token: unknown) => {
      requireCurrentMainFrame(event)
      if (typeof path !== 'string' || path === '') return null
      sessions.track(event.sender)
      const scanToken = tokenOf(token)
      const request = sessions.beginScan(event.sender, scanToken)
      try {
        const result = await scanAndStream(event.sender, path, scanToken, request)
        sessions.finishScan(event.sender.id, request, result !== null)
        return result
      } catch (error) {
        sessions.finishScan(event.sender.id, request, false)
        throw error
      }
    })

    addHandle(FILE_CHANNELS.readFile, async (event, path: unknown, requestIdValue: unknown) => {
      requireCurrentMainFrame(event)
      sessions.track(event.sender)
      const requestId = readIdOf(requestIdValue)
      const abort = sessions.beginRead(event.sender.id, requestId)
      try {
        const authorized = await deps.access.authorizeRead(event.sender.id, path)
        return await deps.reader.read(authorized.realPath, authorized.requestedPath, abort.signal)
      } finally {
        sessions.finishRead(event.sender.id, requestId, abort)
      }
    })

    addHandle(
      FILE_CHANNELS.readFileLimited,
      async (event, path: unknown, maxBytes: unknown, requestIdValue: unknown) => {
        requireCurrentMainFrame(event)
        sessions.track(event.sender)
        const requestId = readIdOf(requestIdValue)
        const abort = sessions.beginRead(event.sender.id, requestId)
        try {
          const authorized = await deps.access.authorizeRead(event.sender.id, path)
          return await deps.reader.readWithin(
            authorized.realPath,
            typeof maxBytes === 'number' ? maxBytes : Number.NaN,
            authorized.requestedPath,
            abort.signal
          )
        } finally {
          sessions.finishRead(event.sender.id, requestId, abort)
        }
      }
    )

    addHandle(FILE_CHANNELS.exportFile, async (event, request: unknown) => {
      requireCurrentMainFrame(event)
      return deps.exporter.write(parseExportRequest(request))
    })

    addHandle(FILE_CHANNELS.pickDirectory, async (event) => {
      requireCurrentMainFrame(event)
      const window = deps.windowFromSender(event.sender)
      return window ? deps.dialogs.pickExportDirectory(window) : null
    })

    addListener(FILE_CHANNELS.confirmFolderScan, (event, token: unknown) => {
      if (!isCurrentMainFrame(event)) return
      sessions.track(event.sender)
      sessions.confirmScan(event.sender.id, token)
    })

    addListener(FILE_CHANNELS.cancelFolderScan, (event, token: unknown) => {
      if (!isCurrentMainFrame(event)) return
      sessions.track(event.sender)
      sessions.cancelScan(event.sender.id, token)
    })

    addListener(FILE_CHANNELS.releaseFolderAccess, (event) => {
      if (!isCurrentMainFrame(event)) return
      sessions.track(event.sender)
      sessions.releaseOwner(event.sender.id)
    })

    addListener(FILE_CHANNELS.cancelFileRead, (event, requestIdValue: unknown) => {
      if (!isCurrentMainFrame(event)) return
      sessions.track(event.sender)
      if (
        typeof requestIdValue !== 'number' ||
        !Number.isSafeInteger(requestIdValue) ||
        requestIdValue <= 0
      ) {
        return
      }
      sessions.cancelRead(event.sender.id, requestIdValue)
    })

    addListener(FILE_CHANNELS.revealInFolder, (event, path: unknown) => {
      if (!isCurrentMainFrame(event)) return
      if (typeof path === 'string' && path !== '') deps.revealInFolder(path)
    })

    addListener(FILE_CHANNELS.noteFileOpened, (event, path: unknown) => {
      if (!isCurrentMainFrame(event)) return
      if (typeof path === 'string' && path !== '' && isVolumeFileName(path)) {
        deps.noteFileOpened(path)
      }
    })
  } catch (error) {
    removeInstalled()
    throw error
  }

  return () => {
    if (disposed) return
    disposed = true
    removeInstalled()
  }
}
