export interface MessageWebContents {
  isDestroyed(): boolean
  send(channel: string, ...args: unknown[]): void
}

export interface WindowWithContents<Contents extends { isDestroyed(): boolean }> {
  isDestroyed(): boolean
  webContents: Contents
}

export type MessageWindow = WindowWithContents<MessageWebContents>

/** Capture the child identity with every native-wrapper getter/check inside
 * the containment boundary. Electron may destroy the window between checks. */
export function windowContentsIfAlive<Contents extends { isDestroyed(): boolean }>(
  window: WindowWithContents<Contents>
): Contents | null {
  try {
    if (window.isDestroyed()) return null
    const contents = window.webContents
    return contents.isDestroyed() ? null : contents
  } catch {
    return null
  }
}

/** Deliver only while both Electron owners are alive; send itself can still
 * race destruction, so a final exception is intentionally contained. */
export function sendIfAlive(window: MessageWindow, channel: string, ...args: unknown[]): boolean {
  const contents = windowContentsIfAlive(window)
  if (!contents) return false
  try {
    contents.send(channel, ...args)
    return true
  } catch {
    return false
  }
}

export function needsCloseConfirmation(
  allowClose: boolean,
  rendererAvailable: boolean,
  webContentsDestroyed: boolean
): boolean {
  return !allowClose && rendererAvailable && !webContentsDestroyed
}

export type CloseResolution = 'close-window' | 'quit-app'

export type CloseRequestResult =
  { kind: 'allow' } | { kind: 'prompt'; requestId: number } | { kind: 'waiting'; requestId: number }

type CloseState =
  | { kind: 'idle' }
  | { kind: 'awaiting'; requestId: number; quitRequested: boolean }
  | { kind: 'allowed' }

/** Tracks which renderer runtime currently owns close replies. Claim and
 * activation are separate so main never treats a runtime as ready before it
 * has received its lease. A newer claim does not disturb the still-active
 * owner until activation, and an old owner's release cannot revoke the new
 * lease. */
export class CloseResponderLeaseState {
  private rendererAvailable = true
  private nextLease = 0
  private latestLease: number | null = null
  private activeLease: number | null = null

  claim(): number {
    this.latestLease = ++this.nextLease
    return this.latestLease
  }

  activate(lease: unknown): boolean {
    if (this.latestLease === null || lease !== this.latestLease) return false
    if (this.rendererAvailable && this.activeLease === this.latestLease) return false
    this.rendererAvailable = true
    this.activeLease = this.latestLease
    return true
  }

  /** Returns true only when the active responder was released. */
  release(lease: unknown): boolean {
    if (typeof lease !== 'number') return false
    if (lease === this.latestLease) this.latestLease = null
    if (lease !== this.activeLease) return false
    this.activeLease = null
    return true
  }

  navigationCommitted(): void {
    this.latestLease = null
    this.activeLease = null
  }

  rendererLost(): void {
    this.rendererAvailable = false
    this.navigationCommitted()
  }

  owns(lease: unknown): boolean {
    return this.activeLease !== null && lease === this.activeLease
  }

  activeLeaseId(): number | null {
    return this.rendererAvailable ? this.activeLease : null
  }

  isReady(): boolean {
    return this.rendererAvailable && this.activeLease !== null
  }
}

/**
 * Correlates the native close event with exactly one renderer reply. Repeated
 * close requests are coalesced; an application quit upgrades an outstanding
 * window-close request instead of replacing it. Late or duplicate replies are
 * inert because both state and request id must match.
 */
export class WindowCloseCoordinator {
  private state: CloseState = { kind: 'idle' }
  private nextRequestId = 0

  request(quitRequested: boolean): CloseRequestResult {
    if (this.state.kind === 'allowed') return { kind: 'allow' }
    if (this.state.kind === 'awaiting') {
      if (quitRequested && !this.state.quitRequested) {
        this.state = { ...this.state, quitRequested: true }
      }
      return { kind: 'waiting', requestId: this.state.requestId }
    }
    const requestId = ++this.nextRequestId
    this.state = { kind: 'awaiting', requestId, quitRequested }
    return { kind: 'prompt', requestId }
  }

  confirm(requestId: unknown): CloseResolution | null {
    if (
      this.state.kind !== 'awaiting' ||
      typeof requestId !== 'number' ||
      requestId !== this.state.requestId
    ) {
      return null
    }
    const resolution = this.state.quitRequested ? 'quit-app' : 'close-window'
    this.state = { kind: 'allowed' }
    return resolution
  }

  cancel(requestId: unknown): boolean {
    if (
      this.state.kind !== 'awaiting' ||
      typeof requestId !== 'number' ||
      requestId !== this.state.requestId
    ) {
      return false
    }
    this.state = { kind: 'idle' }
    return true
  }

  rendererLost(): CloseResolution | null {
    // With no intercepted close there is nothing to authorize. Keeping idle
    // lets a replacement renderer restore confirmation protection later.
    if (this.state.kind !== 'awaiting') return null
    const resolution = this.state.quitRequested ? 'quit-app' : 'close-window'
    this.state = { kind: 'allowed' }
    return resolution
  }

  isAwaiting(): boolean {
    return this.state.kind === 'awaiting'
  }

  isPending(requestId: unknown): boolean {
    return (
      this.state.kind === 'awaiting' &&
      typeof requestId === 'number' &&
      requestId === this.state.requestId
    )
  }

  pendingRequestId(): number | null {
    return this.state.kind === 'awaiting' ? this.state.requestId : null
  }

  isAllowed(): boolean {
    return this.state.kind === 'allowed'
  }
}
