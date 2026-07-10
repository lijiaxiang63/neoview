import type {
  BrowserWindow,
  IpcMain,
  IpcMainEvent,
  IpcMainInvokeEvent,
  WebContents
} from 'electron'
import type { ExportRequest, FolderScan, FolderScanProgress } from '../../shared/files'
import type { FileAccessAuthorizer, ScanAccessRequest } from './access'
import type { FileDialogs } from './dialogs'
import type { ExportService } from './exports'
import { isVolumeFileName } from './names'
import type { FileReader } from './reader'
import type { FolderScanner } from './scanner'

export interface FileIpcDependencies {
  ipc: Pick<IpcMain, 'handle' | 'removeHandler' | 'on' | 'removeListener'>
  access: FileAccessAuthorizer
  dialogs: FileDialogs
  reader: FileReader
  scanner: FolderScanner
  exporter: ExportService
  windowFromSender(sender: WebContents): BrowserWindow | null
  isDirectory(path: string): Promise<boolean>
  revealInFolder(path: string): void
  noteFileOpened(path: string): void
}

type InvokeHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
type EventHandler = (event: IpcMainEvent, ...args: unknown[]) => void
type NavigationDetails = { isMainFrame: boolean; isSameDocument: boolean }

interface TrackedSender {
  sender: WebContents
  onDestroyed: () => void
  onDidStartNavigation: (details: NavigationDetails) => void
  onRenderProcessGone: () => void
}

interface PendingScan {
  token: number
  request: ScanAccessRequest
  confirmed: boolean
  completed: boolean
}

/**
 * Register every file-related channel as one disposable unit. Dependencies
 * are explicit, and a failed/duplicate registration rolls back prior work.
 */
export function registerFileIpc(deps: FileIpcDependencies): () => void {
  const handleChannels: string[] = []
  const eventHandlers: Array<{ channel: string; handler: EventHandler }> = []
  const tracked = new Map<number, TrackedSender>()
  const pendingScans = new Map<number, PendingScan>()
  let disposed = false

  const removeSenderListeners = (entry: TrackedSender): void => {
    entry.sender.removeListener('destroyed', entry.onDestroyed)
    entry.sender.removeListener('did-start-navigation', entry.onDidStartNavigation)
    entry.sender.removeListener('render-process-gone', entry.onRenderProcessGone)
  }

  const releaseOwner = (ownerId: number): void => {
    pendingScans.delete(ownerId)
    deps.access.release(ownerId)
  }

  const trackSender = (sender: WebContents): void => {
    const existing = tracked.get(sender.id)
    if (existing?.sender === sender) return
    if (existing) {
      removeSenderListeners(existing)
      // Never let a new WebContents object inherit access solely through an id reuse.
      releaseOwner(sender.id)
    }
    const onDidStartNavigation = (details: NavigationDetails): void => {
      if (details.isMainFrame && !details.isSameDocument) releaseOwner(sender.id)
    }
    const onRenderProcessGone = (): void => releaseOwner(sender.id)
    const onDestroyed = (): void => {
      const current = tracked.get(sender.id)
      if (current?.sender !== sender) return
      tracked.delete(sender.id)
      removeSenderListeners(current)
      releaseOwner(sender.id)
    }
    tracked.set(sender.id, {
      sender,
      onDestroyed,
      onDidStartNavigation,
      onRenderProcessGone
    })
    sender.once('destroyed', onDestroyed)
    sender.on('did-start-navigation', onDidStartNavigation)
    sender.on('render-process-gone', onRenderProcessGone)
  }

  const removeInstalled = (): void => {
    for (const channel of handleChannels) deps.ipc.removeHandler(channel)
    handleChannels.length = 0
    for (const { channel, handler } of eventHandlers) deps.ipc.removeListener(channel, handler)
    eventHandlers.length = 0
    for (const [ownerId, entry] of tracked) {
      removeSenderListeners(entry)
      releaseOwner(ownerId)
    }
    tracked.clear()
    pendingScans.clear()
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
      if (!activated) activated = deps.access.activateScan(prepared)
      return activated
    }
    const scan = await deps.scanner.scan(path, (files) => {
      // Authorization changes before the batch crosses the boundary, so every
      // path the renderer can display is readable immediately.
      if (!activateCurrent()) return
      if (sender.isDestroyed()) {
        releaseOwner(sender.id)
        return
      }
      const progress: FolderScanProgress = { token, root: path, files }
      sender.send('scan-folder-progress', progress)
    })
    if (!activateCurrent() || sender.isDestroyed()) {
      if (sender.isDestroyed()) releaseOwner(sender.id)
      return null
    }
    return scan
  }

  const tokenOf = (token: unknown): number => (typeof token === 'number' ? token : 0)

  const beginScan = (sender: WebContents, token: number): ScanAccessRequest => {
    const request = deps.access.beginScan(sender.id)
    pendingScans.set(sender.id, { token, request, confirmed: false, completed: false })
    return request
  }

  const finishScan = (
    ownerId: number,
    request: ScanAccessRequest,
    result: FolderScan | null
  ): void => {
    const pending = pendingScans.get(ownerId)
    if (pending?.request !== request) return
    if (result === null) {
      pendingScans.delete(ownerId)
    } else {
      pending.completed = true
      if (pending.confirmed) pendingScans.delete(ownerId)
    }
  }

  try {
    addHandle('open-dialog', async (event) => {
      const window = deps.windowFromSender(event.sender)
      return window ? deps.dialogs.pickAndRead(window) : null
    })

    addHandle('open-folder-scan', async (event, token: unknown) => {
      const window = deps.windowFromSender(event.sender)
      if (!window) return null
      trackSender(event.sender)
      const scanToken = tokenOf(token)
      const request = beginScan(event.sender, scanToken)
      const path = await deps.dialogs.pickScanRoot(window)
      if (path === null) {
        finishScan(event.sender.id, request, null)
        return null
      }
      const result = await scanAndStream(event.sender, path, scanToken, request)
      finishScan(event.sender.id, request, result)
      return result
    })

    // Read-only metadata probe; it changes no authorization state.
    addHandle('is-directory', async (_event, path: unknown) => {
      return typeof path === 'string' && path !== '' ? deps.isDirectory(path) : false
    })

    addHandle('scan-folder', async (event, path: unknown, token: unknown) => {
      if (typeof path !== 'string' || path === '') return null
      trackSender(event.sender)
      const scanToken = tokenOf(token)
      const request = beginScan(event.sender, scanToken)
      const result = await scanAndStream(event.sender, path, scanToken, request)
      finishScan(event.sender.id, request, result)
      return result
    })

    addHandle('read-file', async (event, path: unknown) => {
      trackSender(event.sender)
      const authorized = await deps.access.authorizeRead(event.sender.id, path)
      return deps.reader.read(authorized.realPath, authorized.requestedPath)
    })

    addHandle('read-file-limited', async (event, path: unknown, maxBytes: unknown) => {
      trackSender(event.sender)
      const authorized = await deps.access.authorizeRead(event.sender.id, path)
      return deps.reader.readWithin(
        authorized.realPath,
        typeof maxBytes === 'number' ? maxBytes : Number.NaN,
        authorized.requestedPath
      )
    })

    addHandle('export-file', async (_event, request: unknown) => {
      return deps.exporter.write(request as ExportRequest)
    })

    addHandle('pick-directory', async (event) => {
      const window = deps.windowFromSender(event.sender)
      return window ? deps.dialogs.pickExportDirectory(window) : null
    })

    addListener('confirm-folder-scan', (event, token: unknown) => {
      trackSender(event.sender)
      const pending = pendingScans.get(event.sender.id)
      if (typeof token !== 'number' || pending?.token !== token) return
      if (!deps.access.confirmScan(pending.request)) return
      pending.confirmed = true
      if (pending.completed) pendingScans.delete(event.sender.id)
    })

    addListener('cancel-folder-scan', (event, token: unknown) => {
      trackSender(event.sender)
      const pending = pendingScans.get(event.sender.id)
      if (typeof token !== 'number' || pending?.token !== token) return
      pendingScans.delete(event.sender.id)
      deps.access.cancelScan(event.sender.id)
    })

    addListener('release-folder-access', (event) => {
      trackSender(event.sender)
      releaseOwner(event.sender.id)
    })

    addListener('reveal-in-folder', (_event, path: unknown) => {
      if (typeof path === 'string' && path !== '') deps.revealInFolder(path)
    })

    addListener('note-file-opened', (_event, path: unknown) => {
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
