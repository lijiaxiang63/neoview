import type { WebContents } from 'electron'
import type { FileAccessAuthorizer, ScanAccessRequest } from './access'

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

/** Owns every file capability tied to one renderer main-document identity.
 * Channel registration delegates here so navigation, process loss, id reuse,
 * cancellation, confirmation and disposal share one cleanup authority. */
export class FileSenderSessionRegistry {
  private readonly access: FileAccessAuthorizer
  private readonly tracked = new Map<number, TrackedSender>()
  private readonly pendingScans = new Map<number, PendingScan>()
  private readonly pendingReads = new Map<number, Map<number, AbortController>>()
  private disposed = false

  constructor(access: FileAccessAuthorizer) {
    this.access = access
  }

  track(sender: WebContents): void {
    if (this.disposed) return
    const existing = this.tracked.get(sender.id)
    if (existing?.sender === sender) return
    if (existing) {
      this.removeSenderListeners(existing)
      this.releaseOwner(sender.id)
    }
    const release = (): void => this.releaseOwner(sender.id)
    const onDestroyed = (): void => {
      const current = this.tracked.get(sender.id)
      if (current?.sender !== sender) return
      this.tracked.delete(sender.id)
      this.removeSenderListeners(current)
      this.releaseOwner(sender.id)
    }
    const entry: TrackedSender = {
      sender,
      onDestroyed,
      onDidNavigate: release,
      onRenderProcessGone: release
    }
    this.tracked.set(sender.id, entry)
    sender.once('destroyed', onDestroyed)
    sender.on('did-navigate', entry.onDidNavigate)
    sender.on('render-process-gone', entry.onRenderProcessGone)
  }

  beginRead(ownerId: number, requestId: number): AbortController {
    const reads = this.pendingReads.get(ownerId) ?? new Map<number, AbortController>()
    reads.get(requestId)?.abort()
    const abort = new AbortController()
    reads.set(requestId, abort)
    this.pendingReads.set(ownerId, reads)
    return abort
  }

  finishRead(ownerId: number, requestId: number, abort: AbortController): void {
    const reads = this.pendingReads.get(ownerId)
    if (reads?.get(requestId) !== abort) return
    reads.delete(requestId)
    if (reads.size === 0) this.pendingReads.delete(ownerId)
  }

  cancelRead(ownerId: number, requestId: number): void {
    this.pendingReads.get(ownerId)?.get(requestId)?.abort()
  }

  beginScan(sender: WebContents, token: number): ScanAccessRequest {
    const request = this.access.beginScan(sender.id)
    this.pendingScans.set(sender.id, {
      token,
      request,
      confirmed: false,
      completed: false
    })
    return request
  }

  finishScan(ownerId: number, request: ScanAccessRequest, succeeded: boolean): void {
    const pending = this.pendingScans.get(ownerId)
    if (pending?.request !== request) return
    if (!succeeded) {
      this.pendingScans.delete(ownerId)
      if (this.access.isCurrent(request)) this.access.cancelScan(ownerId)
      return
    }
    pending.completed = true
    if (pending.confirmed) this.pendingScans.delete(ownerId)
  }

  confirmScan(ownerId: number, token: unknown): void {
    const pending = this.pendingScans.get(ownerId)
    if (typeof token !== 'number' || pending?.token !== token) return
    if (!this.access.confirmScan(pending.request)) return
    pending.confirmed = true
    if (pending.completed) this.pendingScans.delete(ownerId)
  }

  cancelScan(ownerId: number, token: unknown): void {
    const pending = this.pendingScans.get(ownerId)
    if (typeof token !== 'number' || pending?.token !== token) return
    this.pendingScans.delete(ownerId)
    this.access.cancelScan(ownerId)
  }

  releaseOwner(ownerId: number): void {
    this.pendingScans.delete(ownerId)
    const reads = this.pendingReads.get(ownerId)
    if (reads) {
      this.pendingReads.delete(ownerId)
      for (const abort of reads.values()) abort.abort()
    }
    this.access.release(ownerId)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const [ownerId, entry] of this.tracked) {
      this.removeSenderListeners(entry)
      this.releaseOwner(ownerId)
    }
    this.tracked.clear()
    this.pendingScans.clear()
    this.pendingReads.clear()
  }

  private removeSenderListeners(entry: TrackedSender): void {
    entry.sender.removeListener('destroyed', entry.onDestroyed)
    entry.sender.removeListener('did-navigate', entry.onDidNavigate)
    entry.sender.removeListener('render-process-gone', entry.onRenderProcessGone)
  }
}
