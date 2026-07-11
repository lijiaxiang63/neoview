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
import type { OpenJobCoordinator } from '../openJobs'
import type { RendererMainFrameGate } from '../rendererProtocol'

export interface FileIpcDependencies {
  ipc: Pick<IpcMain, 'handle' | 'removeHandler' | 'on' | 'removeListener'>
  access: FileAccessAuthorizer
  dialogs: FileDialogs
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
interface TrackedSender {
  sender: WebContents
  onDestroyed: () => void
  onDidNavigate: () => void
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
  const pendingReads = new Map<number, Map<number, AbortController>>()
  let disposed = false

  const isCurrentMainFrame = (event: IpcMainEvent | IpcMainInvokeEvent): boolean =>
    deps.isTrustedMainFrame(event)

  const requireCurrentMainFrame = (event: IpcMainInvokeEvent): void => {
    if (!isCurrentMainFrame(event)) throw new Error('File operation is unavailable.')
  }

  const removeSenderListeners = (entry: TrackedSender): void => {
    entry.sender.removeListener('destroyed', entry.onDestroyed)
    entry.sender.removeListener('did-navigate', entry.onDidNavigate)
    entry.sender.removeListener('render-process-gone', entry.onRenderProcessGone)
  }

  const abortOwnerReads = (ownerId: number): void => {
    const reads = pendingReads.get(ownerId)
    if (!reads) return
    pendingReads.delete(ownerId)
    for (const abort of reads.values()) abort.abort()
  }

  const releaseOwner = (ownerId: number): void => {
    pendingScans.delete(ownerId)
    abortOwnerReads(ownerId)
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
    // Provisional, blocked and failed navigations leave the current document
    // alive. Revoke its access only after a new main document commits.
    const onDidNavigate = (): void => releaseOwner(sender.id)
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
      onDidNavigate,
      onRenderProcessGone
    })
    sender.once('destroyed', onDestroyed)
    sender.on('did-navigate', onDidNavigate)
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
    pendingReads.clear()
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
          releaseOwner(sender.id)
          return
        }
        const progress: FolderScanProgress = { token, root: path, files }
        sender.send('scan-folder-progress', progress)
      },
      () => !disposed && !sender.isDestroyed() && deps.access.isCurrent(prepared)
    )
    if (!activateCurrent() || sender.isDestroyed()) {
      if (sender.isDestroyed()) releaseOwner(sender.id)
      return null
    }
    return scan
  }

  const tokenOf = (token: unknown): number => (typeof token === 'number' ? token : 0)

  const readIdOf = (value: unknown): number => {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
    throw new Error('Invalid file read request.')
  }

  const beginRead = (ownerId: number, requestId: number): AbortController => {
    const reads = pendingReads.get(ownerId) ?? new Map<number, AbortController>()
    const prior = reads.get(requestId)
    prior?.abort()
    const abort = new AbortController()
    reads.set(requestId, abort)
    pendingReads.set(ownerId, reads)
    return abort
  }

  const finishRead = (ownerId: number, requestId: number, abort: AbortController): void => {
    const reads = pendingReads.get(ownerId)
    if (reads?.get(requestId) !== abort) return
    reads.delete(requestId)
    if (reads.size === 0) pendingReads.delete(ownerId)
  }

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
      if (deps.access.isCurrent(request)) deps.access.cancelScan(ownerId)
    } else {
      pending.completed = true
      if (pending.confirmed) pendingScans.delete(ownerId)
    }
  }

  try {
    addHandle('open-dialog', async (event, intentValue: unknown) => {
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

    addHandle('open-overlay-dialog', async (event, requestIdValue: unknown) => {
      requireCurrentMainFrame(event)
      const window = deps.windowFromSender(event.sender)
      if (!window) return null
      trackSender(event.sender)
      const requestId = readIdOf(requestIdValue)
      const abort = beginRead(event.sender.id, requestId)
      try {
        const opened = await deps.dialogs.pickAndRead(window, abort.signal)
        return !abort.signal.aborted && isCurrentMainFrame(event) ? opened : null
      } catch (error) {
        if (abort.signal.aborted || !isCurrentMainFrame(event)) return null
        throw error
      } finally {
        finishRead(event.sender.id, requestId, abort)
      }
    })

    addHandle('open-folder-scan', async (event, token: unknown) => {
      requireCurrentMainFrame(event)
      const window = deps.windowFromSender(event.sender)
      if (!window) return null
      trackSender(event.sender)
      const scanToken = tokenOf(token)
      const request = beginScan(event.sender, scanToken)
      try {
        const path = await deps.dialogs.pickScanRoot(window)
        if (path === null) {
          finishScan(event.sender.id, request, null)
          return null
        }
        const result = await scanAndStream(event.sender, path, scanToken, request)
        finishScan(event.sender.id, request, result)
        return result
      } catch (error) {
        finishScan(event.sender.id, request, null)
        throw error
      }
    })

    // Read-only metadata probe; it changes no authorization state.
    addHandle('is-directory', async (_event, path: unknown) => {
      requireCurrentMainFrame(_event)
      return typeof path === 'string' && path !== '' ? deps.isDirectory(path) : false
    })

    addHandle('scan-folder', async (event, path: unknown, token: unknown) => {
      requireCurrentMainFrame(event)
      if (typeof path !== 'string' || path === '') return null
      trackSender(event.sender)
      const scanToken = tokenOf(token)
      const request = beginScan(event.sender, scanToken)
      try {
        const result = await scanAndStream(event.sender, path, scanToken, request)
        finishScan(event.sender.id, request, result)
        return result
      } catch (error) {
        finishScan(event.sender.id, request, null)
        throw error
      }
    })

    addHandle('read-file', async (event, path: unknown, requestIdValue: unknown) => {
      requireCurrentMainFrame(event)
      trackSender(event.sender)
      const requestId = readIdOf(requestIdValue)
      const abort = beginRead(event.sender.id, requestId)
      try {
        const authorized = await deps.access.authorizeRead(event.sender.id, path)
        return await deps.reader.read(authorized.realPath, authorized.requestedPath, abort.signal)
      } finally {
        finishRead(event.sender.id, requestId, abort)
      }
    })

    addHandle(
      'read-file-limited',
      async (event, path: unknown, maxBytes: unknown, requestIdValue: unknown) => {
        requireCurrentMainFrame(event)
        trackSender(event.sender)
        const requestId = readIdOf(requestIdValue)
        const abort = beginRead(event.sender.id, requestId)
        try {
          const authorized = await deps.access.authorizeRead(event.sender.id, path)
          return await deps.reader.readWithin(
            authorized.realPath,
            typeof maxBytes === 'number' ? maxBytes : Number.NaN,
            authorized.requestedPath,
            abort.signal
          )
        } finally {
          finishRead(event.sender.id, requestId, abort)
        }
      }
    )

    addHandle('export-file', async (event, request: unknown) => {
      requireCurrentMainFrame(event)
      return deps.exporter.write(request as ExportRequest)
    })

    addHandle('pick-directory', async (event) => {
      requireCurrentMainFrame(event)
      const window = deps.windowFromSender(event.sender)
      return window ? deps.dialogs.pickExportDirectory(window) : null
    })

    addListener('confirm-folder-scan', (event, token: unknown) => {
      if (!isCurrentMainFrame(event)) return
      trackSender(event.sender)
      const pending = pendingScans.get(event.sender.id)
      if (typeof token !== 'number' || pending?.token !== token) return
      if (!deps.access.confirmScan(pending.request)) return
      pending.confirmed = true
      if (pending.completed) pendingScans.delete(event.sender.id)
    })

    addListener('cancel-folder-scan', (event, token: unknown) => {
      if (!isCurrentMainFrame(event)) return
      trackSender(event.sender)
      const pending = pendingScans.get(event.sender.id)
      if (typeof token !== 'number' || pending?.token !== token) return
      pendingScans.delete(event.sender.id)
      deps.access.cancelScan(event.sender.id)
    })

    addListener('release-folder-access', (event) => {
      if (!isCurrentMainFrame(event)) return
      trackSender(event.sender)
      releaseOwner(event.sender.id)
    })

    addListener('cancel-file-read', (event, requestIdValue: unknown) => {
      if (!isCurrentMainFrame(event)) return
      trackSender(event.sender)
      if (
        typeof requestIdValue !== 'number' ||
        !Number.isSafeInteger(requestIdValue) ||
        requestIdValue <= 0
      ) {
        return
      }
      pendingReads.get(event.sender.id)?.get(requestIdValue)?.abort()
    })

    addListener('reveal-in-folder', (event, path: unknown) => {
      if (!isCurrentMainFrame(event)) return
      if (typeof path === 'string' && path !== '') deps.revealInFolder(path)
    })

    addListener('note-file-opened', (event, path: unknown) => {
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
