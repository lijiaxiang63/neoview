import { isUpdateCommandId, type UpdateSnapshot, type UpdateState } from '../shared/updates'
import type { UpdateInfo } from './updateCheck'

export interface UpdateSettings {
  autoCheck: boolean
  skippedVersion: string | null
}

/** Retains failed cleanup keys for a later shutdown retry while deduplicating
 * concurrent attempts for the same resource. The injected remover may itself
 * perform bounded platform-specific retries. */
export class RetainedCleanup {
  private readonly pending = new Set<string>()
  private readonly active = new Map<string, Promise<void>>()

  constructor(private readonly remove: (key: string) => Promise<void>) {}

  release(key: string): Promise<void> {
    this.pending.add(key)
    return this.run(key)
  }

  async settle(): Promise<void> {
    await Promise.all(this.active.values())
    await Promise.all([...this.pending].map((key) => this.run(key)))
  }

  pendingCount(): number {
    return this.pending.size
  }

  private run(key: string): Promise<void> {
    const existing = this.active.get(key)
    if (existing) return existing
    const task = Promise.resolve()
      .then(() => this.remove(key))
      .then(
        () => {
          this.pending.delete(key)
        },
        () => undefined
      )
      .finally(() => {
        if (this.active.get(key) === task) this.active.delete(key)
      })
    this.active.set(key, task)
    return task
  }
}

export interface DownloadOutput {
  readonly closed: boolean
  once(event: 'close', listener: () => void): unknown
  destroy(): void
}

/** Production boundary for a failed or cancelled output: attach the close
 * waiter before destroy so even a synchronous close cannot be missed, then
 * begin directory cleanup only after that handle is gone. */
export async function releaseFailedDownload(
  output: DownloadOutput | null,
  releaseDirectory: () => Promise<void>
): Promise<void> {
  if (output && !output.closed) {
    try {
      await new Promise<void>((resolve) => {
        output.once('close', resolve)
        output.destroy()
      })
    } catch {
      // Preserve the original network or integrity error.
    }
  }
  try {
    await releaseDirectory()
  } catch {
    // RetainedCleanup owns retry policy; preserve the original download error.
  }
}

/** Shutdown barrier used by the Electron adapter. Installer hand-off becomes
 * ready only after controller persistence/resources and every retained cleanup
 * retry have settled. */
export async function settleUpdateShutdown(
  settings: Promise<void>,
  resources: Promise<void>,
  cleanup: Pick<RetainedCleanup, 'settle'>,
  markReady: () => void
): Promise<void> {
  await Promise.all([settings, resources])
  await cleanup.settle()
  markReady()
}

export interface UpdateControllerDependencies {
  currentVersion: string
  settings: UpdateSettings
  check(signal: AbortSignal): Promise<UpdateInfo | null>
  download(
    update: UpdateInfo,
    signal: AbortSignal,
    onProgress: (received: number, total: number) => void
  ): Promise<string | null>
  saveSettings(settings: UpdateSettings): Promise<void>
  /** Release a successfully downloaded product that was never handed to the
   * platform or user. The adapter removes only its own temporary directory. */
  releaseDownloaded(path: string): Promise<void>
  onState(snapshot: UpdateSnapshot): void
}

export interface UpdateController {
  state(): UpdateState
  snapshot(): UpdateSnapshot
  autoCheckEnabled(): boolean
  setAutoCheck(enabled: boolean): void
  check(manual: boolean): Promise<void>
  download(expectedCommandId: number): Promise<string | null>
  cancelDownload(expectedCommandId: number): void
  skip(version: string, expectedCommandId: number): void
  dismiss(expectedCommandId: number): void
  downloadedPath(): string | null
  handoffDownloaded(path: string): boolean
  ownsReadyDownload(expectedCommandId: number, path: string): boolean
  installFailed(expectedCommandId: number, message: string): void
  markSaved(expectedCommandId: number, path: string): boolean
  dispose(): void
  /** Test/shutdown hook for the serialized persistence tail. */
  settingsSettled(): Promise<void>
  resourcesSettled(): Promise<void>
}

const IDLE: UpdateState = { phase: 'idle' }

function refOf(update: UpdateInfo): Extract<UpdateState, { phase: 'available' }>['info'] {
  return {
    version: update.version,
    notesUrl: update.notesUrl,
    assetName: update.asset.name,
    assetSize: update.asset.size
  }
}

/** Pure application-level update state machine. Network, files, timers and
 * process integration are injected by the Electron adapter in update.ts. */
export function createUpdateController(deps: UpdateControllerDependencies): UpdateController {
  let settings = { ...deps.settings }
  let currentState: UpdateState = IDLE
  let revision = 0
  let commandId = 0
  let pendingUpdate: UpdateInfo | null = null
  let downloaded: string | null = null
  let checking: Promise<void> | null = null
  let checkAbort: AbortController | null = null
  let checkGeneration = 0
  let reportManual = false
  let downloadAbort: AbortController | null = null
  let downloadGeneration = 0
  let settingsTail: Promise<void> = Promise.resolve()
  const cleanupTasks = new Set<Promise<void>>()
  const downloadTasks = new Set<Promise<string | null>>()
  let disposed = false

  const publish = (state: UpdateState, newCommand = true): void => {
    if (disposed) return
    currentState = state
    if (newCommand) commandId++
    deps.onState({ revision: ++revision, commandId, state })
  }

  const ownsCommand = (expectedCommandId: number): boolean =>
    isUpdateCommandId(expectedCommandId) && expectedCommandId === commandId

  const persist = (): void => {
    const snapshot = { ...settings }
    settingsTail = settingsTail
      .then(() => deps.saveSettings(snapshot))
      .catch(() => {
        // A settings failure must not break later writes in the queue.
      })
  }

  const releasePath = (path: string): void => {
    let task: Promise<void>
    try {
      task = deps.releaseDownloaded(path).catch(() => {})
    } catch {
      return
    }
    cleanupTasks.add(task)
    void task.finally(() => cleanupTasks.delete(task))
  }

  const releaseOwnedDownload = (): void => {
    if (!downloaded) return
    const path = downloaded
    downloaded = null
    releasePath(path)
  }

  const invalidateCheck = (): void => {
    if (!checking && !checkAbort) return
    checkGeneration++
    checkAbort?.abort()
    checkAbort = null
    checking = null
    reportManual = false
  }

  const controller: UpdateController = {
    state: () => currentState,

    snapshot: () => ({ revision, commandId, state: currentState }),

    autoCheckEnabled: () => settings.autoCheck,

    setAutoCheck(enabled) {
      if (disposed || settings.autoCheck === enabled) return
      settings = { ...settings, autoCheck: enabled }
      persist()
    },

    check(manual) {
      if (disposed) return Promise.resolve()
      // A completed or active download owns the application-level state. A
      // menu check during that phase must not hide its progress or race a
      // different release into `pendingUpdate`.
      if (
        currentState.phase === 'downloading' ||
        currentState.phase === 'ready' ||
        currentState.phase === 'saved'
      ) {
        return Promise.resolve()
      }
      if (checking) {
        if (manual && !reportManual) {
          reportManual = true
          publish({ phase: 'checking' })
        }
        return checking
      }
      reportManual = manual
      if (manual) publish({ phase: 'checking' })
      const abort = new AbortController()
      const generation = ++checkGeneration
      checkAbort = abort
      const run = (async (): Promise<void> => {
        try {
          const update = await Promise.resolve().then(() => deps.check(abort.signal))
          if (disposed || generation !== checkGeneration) return
          if (!update) {
            pendingUpdate = null
            releaseOwnedDownload()
            if (reportManual) publish({ phase: 'none', version: deps.currentVersion })
            else publish(IDLE)
          } else if (!reportManual && update.version === settings.skippedVersion) {
            pendingUpdate = null
            releaseOwnedDownload()
            publish(IDLE)
          } else {
            pendingUpdate = update
            releaseOwnedDownload()
            publish({ phase: 'available', info: refOf(update), error: null })
          }
        } catch (error) {
          if (!disposed && generation === checkGeneration && reportManual) {
            publish({
              phase: 'error',
              message: error instanceof Error ? error.message : 'update check failed'
            })
          }
        } finally {
          if (checkAbort === abort) {
            checking = null
            checkAbort = null
            reportManual = false
          }
        }
      })()
      checking = run
      return run
    },

    async download(expectedCommandId) {
      if (disposed) return null
      if (!ownsCommand(expectedCommandId)) {
        publish(currentState, false)
        return null
      }
      const update = pendingUpdate
      if (!update) throw new Error('No update available to download.')
      // A silent check leaves the available card interactive. Once the user
      // acts on it, that command owns state even if the check ignores abort.
      invalidateCheck()
      releaseOwnedDownload()
      downloadAbort?.abort()
      const abort = new AbortController()
      downloadAbort = abort
      const generation = ++downloadGeneration
      const info = refOf(update)
      publish({ phase: 'downloading', info, received: 0, total: info.assetSize })
      try {
        const task = deps.download(update, abort.signal, (received, total) => {
          if (
            !disposed &&
            generation === downloadGeneration &&
            currentState.phase === 'downloading'
          ) {
            publish({ phase: 'downloading', info, received, total }, false)
          }
        })
        downloadTasks.add(task)
        let path: string | null
        try {
          path = await task
        } finally {
          downloadTasks.delete(task)
        }
        if (disposed || generation !== downloadGeneration) {
          if (path) releasePath(path)
          return null
        }
        if (!path || abort.signal.aborted) {
          publish(IDLE)
          return null
        }
        downloaded = path
        publish({ phase: 'ready', info, error: null })
        return path
      } catch (error) {
        if (disposed || generation !== downloadGeneration) return null
        if (abort.signal.aborted) {
          publish(IDLE)
          return null
        }
        publish({
          phase: 'available',
          info,
          error: error instanceof Error ? error.message : 'Download failed.'
        })
        throw error
      } finally {
        if (downloadAbort === abort) downloadAbort = null
      }
    },

    cancelDownload(expectedCommandId) {
      if (disposed) return
      if (!ownsCommand(expectedCommandId)) {
        publish(currentState, false)
        return
      }
      if (currentState.phase !== 'downloading') {
        // A renderer click can arrive after completion won the race. Replay
        // the authoritative state so a stale local card cannot hide `ready`.
        publish(currentState, false)
        return
      }
      downloadGeneration++
      downloadAbort?.abort()
      downloadAbort = null
      publish(IDLE)
    },

    skip(version, expectedCommandId) {
      // A click can arrive after a newer check replaced the card. Never let
      // that stale renderer event dismiss or release the current update.
      if (disposed || !version) return
      if (!ownsCommand(expectedCommandId)) {
        publish(currentState, false)
        return
      }
      if (pendingUpdate?.version !== version) return
      invalidateCheck()
      settings = { ...settings, skippedVersion: version }
      persist()
      pendingUpdate = null
      // A fast second click can race the downloading event back to React.
      // Invalidate and abort that task so its late path is released instead
      // of reviving ready state after the skip.
      if (currentState.phase === 'downloading') controller.cancelDownload(expectedCommandId)
      else {
        releaseOwnedDownload()
        publish(IDLE)
      }
    },

    dismiss(expectedCommandId) {
      if (disposed) return
      if (!ownsCommand(expectedCommandId)) {
        publish(currentState, false)
        return
      }
      invalidateCheck()
      if (currentState.phase === 'downloading') controller.cancelDownload(expectedCommandId)
      else {
        if (currentState.phase === 'ready') releaseOwnedDownload()
        publish(IDLE)
      }
    },

    downloadedPath: () => downloaded,

    handoffDownloaded(path) {
      if (disposed || downloaded !== path) return false
      downloaded = null
      return true
    },

    ownsReadyDownload(expectedCommandId, path) {
      return (
        !disposed &&
        ownsCommand(expectedCommandId) &&
        currentState.phase === 'ready' &&
        downloaded === path
      )
    },

    installFailed(expectedCommandId, message) {
      if (
        disposed ||
        !ownsCommand(expectedCommandId) ||
        currentState.phase !== 'ready' ||
        downloaded === null
      ) {
        return
      }
      publish({
        phase: 'ready',
        info: currentState.info,
        error: message || 'Install failed.'
      })
    },

    markSaved(expectedCommandId, path) {
      if (
        !controller.ownsReadyDownload(expectedCommandId, path) ||
        currentState.phase !== 'ready'
      ) {
        return false
      }
      const info = currentState.info
      downloaded = null
      publish({ phase: 'saved', info })
      return true
    },

    dispose() {
      if (disposed) return
      disposed = true
      checkAbort?.abort()
      checkAbort = null
      downloadGeneration++
      downloadAbort?.abort()
      downloadAbort = null
      releaseOwnedDownload()
    },

    settingsSettled: () => settingsTail,

    resourcesSettled: async () => {
      await Promise.all([...downloadTasks].map((task) => task.catch(() => null)))
      await Promise.all([...cleanupTasks])
    }
  }

  return controller
}

export interface PreventableQuitEvent {
  preventDefault(): void
}

/** Installer hand-off is best-effort, but the already-authorized final exit
 * must happen even if platform launch preparation throws synchronously. */
export function finalizeApplicationExit(handoff: () => void, exit: () => void): void {
  try {
    handoff()
  } catch {
    // Exiting is safer than leaving a headless application running.
  }
  exit()
}

/** Holds quit while asynchronous shutdown settles, coalesces repeated
 * attempts, and invokes one explicit final-exit callback. */
export class AsyncQuitCoordinator {
  private phase: 'idle' | 'pending' | 'complete' = 'idle'

  intercept(
    event: PreventableQuitEvent,
    shutdown: () => Promise<void>,
    retry: () => void
  ): boolean {
    if (this.phase === 'complete') return false
    event.preventDefault()
    if (this.phase === 'pending') return true
    this.phase = 'pending'
    const finish = (): void => {
      this.phase = 'complete'
      retry()
    }
    try {
      void shutdown().then(finish, finish)
    } catch {
      finish()
    }
    return true
  }

  allowsWindowCreation(): boolean {
    return this.phase === 'idle'
  }
}

/** Owns a bounded class of adapter tasks so application shutdown can await
 * invocations that were already accepted before their IPC was disposed. */
export class PendingTasks {
  private readonly tasks = new Set<Promise<unknown>>()

  track<T>(task: Promise<T>): Promise<T> {
    this.tasks.add(task)
    void task.then(
      () => this.tasks.delete(task),
      () => this.tasks.delete(task)
    )
    return task
  }

  async settle(): Promise<void> {
    await Promise.all([...this.tasks].map((task) => task.catch(() => undefined)))
  }
}

export interface SavedProductPreparation {
  prepare(path: string): Promise<void>
  reveal(path: string): void
}

/** Prepare and reveal a user-owned product before atomically transferring it
 * out of controller cleanup. A dismiss/dispose during the await wins. */
export async function prepareSavedProduct(
  controller: Pick<UpdateController, 'ownsReadyDownload' | 'markSaved'>,
  expectedCommandId: number,
  path: string,
  deps: SavedProductPreparation
): Promise<boolean> {
  await deps.prepare(path)
  if (!controller.ownsReadyDownload(expectedCommandId, path)) return false
  deps.reveal(path)
  return controller.markSaved(expectedCommandId, path)
}

/** Owns an optional installer path across the held quit. Preparation
 * transfers it out of controller cleanup; only a ready final exit can take it,
 * and then at most once. */
export class FinalQuitInstaller {
  private path: string | null = null
  private ready = false

  arm(path: string): void {
    this.path = path
  }

  cancel(): void {
    this.path = null
  }

  prepare(handoff: (path: string) => boolean): void {
    if (this.path && !handoff(this.path)) this.path = null
  }

  markReady(): void {
    this.ready = true
  }

  isReady(): boolean {
    return this.ready
  }

  take(): string | null {
    if (!this.ready) return null
    const path = this.path
    this.path = null
    return path
  }
}
