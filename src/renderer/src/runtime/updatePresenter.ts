import type {
  UpdateInstallResult,
  UpdateRef,
  UpdateSnapshot,
  UpdateState
} from '../../../shared/updates'
import {
  INITIAL_UPDATE_SNAPSHOT,
  ownedUpdateFallback,
  UpdateCommandLatch,
  type UpdateCommandOwner,
  UpdateSnapshotReceiver,
  updateResultAutoDismisses
} from './updateSnapshots'

export interface UpdatePresenterBridge {
  platform: string
  getUpdateState(): Promise<UpdateSnapshot>
  onUpdateState(callback: (snapshot: UpdateSnapshot) => void): () => void
  downloadUpdate(commandId: number): Promise<string | null>
  installUpdate(commandId: number): Promise<UpdateInstallResult>
  cancelUpdateDownload(commandId: number): void
  skipUpdateVersion(version: string, commandId: number): void
  dismissUpdate(commandId: number): void
}

export interface UpdatePresenterSnapshot {
  update: UpdateSnapshot
  commandPending: boolean
}

export interface UpdatePresenterTimers {
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>
  clearTimeout(handle: ReturnType<typeof setTimeout>): void
}

const RESULT_MS = 6000

function ipcErrorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : 'Update failed.'
  return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/** Owns update subscription/query ordering, command latching, fallbacks and
 * timers outside React. The notification component only renders a snapshot. */
export class UpdatePresenter {
  readonly platform: string
  private readonly bridge: UpdatePresenterBridge
  private readonly timers: UpdatePresenterTimers
  private readonly openExternal: (url: string) => void
  private readonly receiver = new UpdateSnapshotReceiver()
  private readonly latch = new UpdateCommandLatch()
  private readonly listeners = new Set<() => void>()
  private snapshot: UpdatePresenterSnapshot = {
    update: INITIAL_UPDATE_SNAPSHOT,
    commandPending: false
  }
  private unsubscribe: (() => void) | null = null
  private resultTimer: ReturnType<typeof setTimeout> | undefined
  private active = false
  private disposed = false

  constructor(deps: {
    bridge: UpdatePresenterBridge
    openExternal(url: string): void
    timers?: UpdatePresenterTimers
  }) {
    this.bridge = deps.bridge
    this.platform = deps.bridge.platform
    this.openExternal = deps.openExternal
    this.timers = deps.timers ?? {
      setTimeout: (callback, delay) => setTimeout(callback, delay),
      clearTimeout: (handle) => clearTimeout(handle)
    }
  }

  init(): void {
    if (this.active || this.disposed) return
    this.active = true
    this.unsubscribe = this.bridge.onUpdateState((snapshot) => this.accept(snapshot))
    void this.bridge.getUpdateState().then(
      (snapshot) => this.accept(snapshot),
      () => undefined
    )
  }

  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => undefined
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): UpdatePresenterSnapshot => this.snapshot

  openNotes(url: string): void {
    this.openExternal(url)
  }

  async download(info: UpdateRef, expected: UpdateSnapshot): Promise<void> {
    const command = this.beginCommand(expected)
    if (!command) return
    try {
      await this.bridge.downloadUpdate(command.commandId)
    } catch (error) {
      this.setLocalFallback(command, {
        phase: 'available',
        info,
        error: ipcErrorText(error)
      })
    } finally {
      this.finishCommand(command.token)
    }
  }

  async install(info: UpdateRef, expected: UpdateSnapshot): Promise<void> {
    const command = this.beginCommand(expected)
    if (!command) return
    try {
      await this.bridge.installUpdate(command.commandId)
    } catch (error) {
      this.setLocalFallback(command, {
        phase: 'ready',
        info,
        error: ipcErrorText(error)
      })
    } finally {
      this.finishCommand(command.token)
    }
  }

  dismiss(expected: UpdateSnapshot): void {
    const command = this.beginCommand(expected)
    if (!command) return
    try {
      if (expected.state.phase === 'downloading') {
        this.bridge.cancelUpdateDownload(command.commandId)
      } else {
        this.bridge.dismissUpdate(command.commandId)
      }
    } catch {
      this.finishCommand(command.token)
    }
  }

  skip(version: string, expected: UpdateSnapshot): void {
    const command = this.beginCommand(expected)
    if (!command) return
    try {
      this.bridge.skipUpdateVersion(version, command.commandId)
    } catch {
      this.finishCommand(command.token)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.active = false
    this.unsubscribe?.()
    this.unsubscribe = null
    this.receiver.dispose()
    this.latch.reset()
    this.clearResultTimer()
    this.listeners.clear()
  }

  private accept(incoming: UpdateSnapshot): void {
    if (!this.active) return
    const accepted = this.receiver.accept(incoming)
    if (!accepted) return
    const advanced = accepted.revision > this.snapshot.update.revision
    if (advanced) this.latch.reset()
    this.publish({
      update: accepted,
      commandPending: advanced ? false : this.snapshot.commandPending
    })
    this.scheduleResultDismiss()
  }

  private beginCommand(expected: UpdateSnapshot): UpdateCommandOwner | null {
    const latest = this.snapshot.update
    if (latest.revision !== expected.revision || latest.commandId !== expected.commandId) {
      return null
    }
    const token = this.latch.begin()
    if (token === null) return null
    this.publish({ ...this.snapshot, commandPending: true })
    return { token, revision: latest.revision, commandId: latest.commandId }
  }

  private finishCommand(token: number): void {
    if (this.latch.release(token)) this.publish({ ...this.snapshot, commandPending: false })
  }

  private setLocalFallback(owner: UpdateCommandOwner, state: UpdateState): void {
    const update = ownedUpdateFallback(this.snapshot.update, owner, this.latch, state)
    if (update) this.publish({ ...this.snapshot, update })
  }

  private scheduleResultDismiss(): void {
    this.clearResultTimer()
    if (!updateResultAutoDismisses(this.snapshot.update.state)) return
    this.resultTimer = this.timers.setTimeout(() => {
      this.resultTimer = undefined
      this.dismiss(this.snapshot.update)
    }, RESULT_MS)
  }

  private clearResultTimer(): void {
    if (this.resultTimer === undefined) return
    this.timers.clearTimeout(this.resultTimer)
    this.resultTimer = undefined
  }

  private publish(snapshot: UpdatePresenterSnapshot): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
}
