import { describe, expect, it, vi } from 'vitest'
import {
  AsyncQuitCoordinator,
  createUpdateController,
  finalizeApplicationExit,
  FinalQuitInstaller,
  PendingTasks,
  prepareSavedProduct,
  releaseFailedDownload,
  RetainedCleanup,
  settleUpdateShutdown,
  type UpdateSettings
} from '../src/main/updateService'
import type { UpdateInfo } from '../src/main/updateCheck'
import { shouldCreateWindowOnActivate } from '../src/main/appLifecycle'
import { isUpdateCommandId, type UpdateSnapshot, type UpdateState } from '../src/shared/updates'

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const update: UpdateInfo = {
  version: '2.0.0',
  notesUrl: 'https://example.test/release',
  asset: { name: 'installer.bin', url: 'https://example.test/file', size: 100, digest: null }
}

function harness(
  options: {
    check?: (signal: AbortSignal) => Promise<UpdateInfo | null>
    download?: (
      update: UpdateInfo,
      signal: AbortSignal,
      onProgress: (received: number, total: number) => void
    ) => Promise<string | null>
    save?: (settings: UpdateSettings) => Promise<void>
    release?: (path: string) => Promise<void>
  } = {}
): {
  controller: ReturnType<typeof createUpdateController>
  states: UpdateState[]
  snapshots: UpdateSnapshot[]
} {
  const states: UpdateState[] = []
  const snapshots: UpdateSnapshot[] = []
  const controller = createUpdateController({
    currentVersion: '1.0.0',
    settings: { autoCheck: true, skippedVersion: null },
    check: options.check ?? (async () => update),
    download: options.download ?? (async () => '/tmp/installer'),
    saveSettings: options.save ?? (async () => {}),
    releaseDownloaded: options.release ?? (async () => {}),
    onState: (snapshot) => {
      snapshots.push(snapshot)
      states.push(snapshot.state)
    }
  })
  return { controller, states, snapshots }
}

describe('update controller', () => {
  it('rejects missing and malformed command ids at the IPC payload guard', () => {
    expect(isUpdateCommandId(0)).toBe(true)
    expect(isUpdateCommandId(42)).toBe(true)
    for (const value of [undefined, null, '1', -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isUpdateCommandId(value)).toBe(false)
    }
  })

  it('serializes settings writes and captures each call-time snapshot', async () => {
    const first = deferred<void>()
    const second = deferred<void>()
    const saves: UpdateSettings[] = []
    const save = vi.fn((settings: UpdateSettings) => {
      saves.push(settings)
      return saves.length === 1 ? first.promise : second.promise
    })
    const h = harness({ save })
    await h.controller.check(true)

    h.controller.setAutoCheck(false)
    h.controller.skip('2.0.0', h.controller.snapshot().commandId)
    await Promise.resolve()
    expect(save).toHaveBeenCalledTimes(1)
    expect(saves[0]).toEqual({ autoCheck: false, skippedVersion: null })

    first.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(save).toHaveBeenCalledTimes(2)
    expect(saves[1]).toEqual({ autoCheck: false, skippedVersion: '2.0.0' })
    second.resolve()
    await h.controller.settingsSettled()
  })

  it('promotes an in-flight silent check and publishes its result to current state', async () => {
    const result = deferred<UpdateInfo | null>()
    const h = harness({ check: () => result.promise })
    const silent = h.controller.check(false)
    const manual = h.controller.check(true)
    expect(h.controller.state()).toEqual({ phase: 'checking' })
    result.resolve(update)
    await Promise.all([silent, manual])
    expect(h.controller.state()).toMatchObject({ phase: 'available', info: { version: '2.0.0' } })
  })

  it('cancels a download immediately and ignores its late completion', async () => {
    const result = deferred<string | null>()
    let signal: AbortSignal | null = null
    const h = harness({
      download: async (_update, nextSignal, onProgress) => {
        signal = nextSignal
        onProgress(25, 100)
        return result.promise
      }
    })
    await h.controller.check(true)
    const download = h.controller.download(h.controller.snapshot().commandId)
    await Promise.resolve()
    expect(h.controller.state()).toMatchObject({ phase: 'downloading', received: 25 })
    h.controller.cancelDownload(h.controller.snapshot().commandId)
    expect(signal?.aborted).toBe(true)
    expect(h.controller.state()).toEqual({ phase: 'idle' })
    result.resolve('/tmp/late')
    await expect(download).resolves.toBeNull()
    expect(h.controller.downloadedPath()).toBeNull()
  })

  it('accepts cancel from an older progress snapshot of the same download', async () => {
    const result = deferred<string | null>()
    let signal: AbortSignal | null = null
    let progress: ((received: number, total: number) => void) | null = null
    const h = harness({
      download: async (_update, nextSignal, onProgress) => {
        signal = nextSignal
        progress = onProgress
        return result.promise
      }
    })
    await h.controller.check(true)
    const downloading = h.controller.download(h.controller.snapshot().commandId)
    await Promise.resolve()
    const commandId = h.controller.snapshot().commandId
    const revision = h.controller.snapshot().revision
    progress?.(50, 100)
    expect(h.controller.snapshot().revision).toBeGreaterThan(revision)
    expect(h.controller.snapshot().commandId).toBe(commandId)

    h.controller.cancelDownload(commandId)
    expect(signal?.aborted).toBe(true)
    result.resolve(null)
    await downloading
    expect(h.controller.state().phase).toBe('idle')
  })

  it('retains ready state as a queryable application snapshot', async () => {
    const h = harness()
    await h.controller.check(true)
    await h.controller.download(h.controller.snapshot().commandId)
    expect(h.controller.state()).toMatchObject({ phase: 'ready', info: { version: '2.0.0' } })
    expect(h.controller.downloadedPath()).toBe('/tmp/installer')
  })

  it('replays ready state when a cancel arrives after download completion', async () => {
    const release = vi.fn(async () => {})
    const h = harness({ release })
    await h.controller.check(true)
    await h.controller.download(h.controller.snapshot().commandId)
    const eventsBefore = h.states.length

    h.controller.cancelDownload(h.controller.snapshot().commandId)
    expect(h.controller.state()).toMatchObject({ phase: 'ready', info: { version: '2.0.0' } })
    expect(h.controller.downloadedPath()).toBe('/tmp/installer')
    expect(h.states).toHaveLength(eventsBefore + 1)
    expect(h.states.at(-1)?.phase).toBe('ready')
    expect(release).not.toHaveBeenCalled()
  })

  it('does not let an old cancel abort a newer download', async () => {
    const first = deferred<string | null>()
    const second = deferred<string | null>()
    const signals: AbortSignal[] = []
    let downloadCount = 0
    const h = harness({
      download: async (_update, signal) => {
        signals.push(signal)
        return downloadCount++ === 0 ? first.promise : second.promise
      }
    })
    await h.controller.check(true)
    const firstDownload = h.controller.download(h.controller.snapshot().commandId)
    await Promise.resolve()
    const staleCommand = h.controller.snapshot().commandId
    h.controller.cancelDownload(staleCommand)
    first.resolve(null)
    await firstDownload

    await h.controller.check(true)
    const secondDownload = h.controller.download(h.controller.snapshot().commandId)
    await Promise.resolve()
    h.controller.cancelDownload(staleCommand)
    expect(signals[1].aborted).toBe(false)
    expect(h.controller.state().phase).toBe('downloading')
    second.resolve('/tmp/current')
    await secondDownload
    expect(h.controller.downloadedPath()).toBe('/tmp/current')
  })

  it('does not start a download from an obsolete available snapshot', async () => {
    const download = vi.fn(async () => '/tmp/installer')
    const h = harness({ download })
    await h.controller.check(true)
    const staleCommand = h.controller.snapshot().commandId
    await h.controller.check(true)

    await expect(h.controller.download(staleCommand)).resolves.toBeNull()
    expect(download).not.toHaveBeenCalled()
    expect(h.controller.state().phase).toBe('available')
  })

  it('does not treat a missing command id as unchecked controller access', async () => {
    const download = vi.fn(async () => '/tmp/installer')
    const h = harness({ download })
    await h.controller.check(true)
    const before = h.controller.snapshot()

    await expect(h.controller.download(undefined as unknown as number)).resolves.toBeNull()
    expect(download).not.toHaveBeenCalled()
    expect(h.controller.state().phase).toBe('available')
    expect(h.controller.snapshot().commandId).toBe(before.commandId)
    expect(h.controller.snapshot().revision).toBeGreaterThan(before.revision)
  })

  it('does not let a check replace download-owned state', async () => {
    const result = deferred<string | null>()
    const check = vi.fn(async () => update)
    const h = harness({ check, download: async () => result.promise })
    await h.controller.check(true)
    const download = h.controller.download(h.controller.snapshot().commandId)

    await h.controller.check(true)
    expect(check).toHaveBeenCalledTimes(1)
    expect(h.controller.state().phase).toBe('downloading')
    result.resolve('/tmp/installer')
    await download
  })

  it('invalidates a silent check when download starts from its still-visible card', async () => {
    const silentResult = deferred<UpdateInfo | null>()
    const downloadResult = deferred<string | null>()
    let checks = 0
    let silentSignal: AbortSignal | null = null
    const h = harness({
      check: async (signal) => {
        if (checks++ === 0) return update
        silentSignal = signal
        return silentResult.promise
      },
      download: async () => downloadResult.promise
    })
    await h.controller.check(true)
    const silent = h.controller.check(false)
    await Promise.resolve()
    expect(h.controller.state().phase).toBe('available')

    const downloading = h.controller.download(h.controller.snapshot().commandId)
    expect(silentSignal?.aborted).toBe(true)
    expect(h.controller.state().phase).toBe('downloading')
    silentResult.resolve(null)
    await silent
    expect(h.controller.state().phase).toBe('downloading')

    downloadResult.resolve('/tmp/current')
    await downloading
    expect(h.controller.state().phase).toBe('ready')
    expect(h.controller.downloadedPath()).toBe('/tmp/current')
  })

  it('aborts an in-flight check on disposal', async () => {
    const result = deferred<UpdateInfo | null>()
    let signal: AbortSignal | null = null
    const h = harness({
      check: (nextSignal) => {
        signal = nextSignal
        return result.promise
      }
    })
    const check = h.controller.check(false)
    await Promise.resolve()
    h.controller.dispose()
    expect(signal?.aborted).toBe(true)
    result.resolve(update)
    await check
    expect(h.states).toEqual([])
  })

  it('releases a dismissed ready download exactly once', async () => {
    const release = vi.fn(async () => {})
    const h = harness({ release })
    await h.controller.check(true)
    await h.controller.download(h.controller.snapshot().commandId)

    h.controller.dismiss(h.controller.snapshot().commandId)
    h.controller.dispose()
    await h.controller.resourcesSettled()
    expect(release).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledWith('/tmp/installer')
    expect(h.controller.downloadedPath()).toBeNull()
  })

  it('keeps a failed install retryable and rejects the old card dismiss timer', async () => {
    const release = vi.fn(async () => {})
    const h = harness({ release })
    await h.controller.check(true)
    await h.controller.download(h.controller.snapshot().commandId)
    const before = h.controller.snapshot()

    h.controller.installFailed(before.commandId, 'Preparation failed.')

    expect(h.controller.state()).toMatchObject({
      phase: 'ready',
      error: 'Preparation failed.'
    })
    expect(h.controller.downloadedPath()).toBe('/tmp/installer')
    expect(h.controller.snapshot().revision).toBeGreaterThan(before.revision)
    expect(h.controller.snapshot().commandId).toBeGreaterThan(before.commandId)

    h.controller.dismiss(before.commandId)
    expect(h.controller.state().phase).toBe('ready')
    expect(h.controller.downloadedPath()).toBe('/tmp/installer')
    expect(release).not.toHaveBeenCalled()

    h.controller.dismiss(h.controller.snapshot().commandId)
    await h.controller.resourcesSettled()
    expect(release).toHaveBeenCalledWith('/tmp/installer')
  })

  it('ignores a delayed dismiss from an older transient snapshot', async () => {
    let checks = 0
    const h = harness({ check: async () => (++checks === 1 ? null : update) })
    await h.controller.check(true)
    const staleCommand = h.controller.snapshot().commandId
    expect(h.controller.state().phase).toBe('none')

    await h.controller.check(true)
    expect(h.controller.state().phase).toBe('available')
    h.controller.dismiss(staleCommand)
    expect(h.controller.state()).toMatchObject({
      phase: 'available',
      info: { version: update.version }
    })
  })

  it('keeps a ready product across snapshots until platform handoff', async () => {
    const release = vi.fn(async () => {})
    const h = harness({ release })
    await h.controller.check(true)
    await h.controller.download(h.controller.snapshot().commandId)
    expect(h.controller.state().phase).toBe('ready')
    expect(h.controller.handoffDownloaded('/tmp/other')).toBe(false)
    expect(h.controller.handoffDownloaded('/tmp/installer')).toBe(true)

    h.controller.dispose()
    await h.controller.resourcesSettled()
    expect(release).not.toHaveBeenCalled()
  })

  it('marks a ready product saved only for its current command and exact path', async () => {
    const release = vi.fn(async () => {})
    const h = harness({ release })
    await h.controller.check(true)
    const staleCommand = h.controller.snapshot().commandId
    await h.controller.check(true)
    await h.controller.download(h.controller.snapshot().commandId)
    const currentCommand = h.controller.snapshot().commandId

    expect(h.controller.markSaved(staleCommand, '/tmp/installer')).toBe(false)
    expect(h.controller.markSaved(currentCommand, '/tmp/other')).toBe(false)
    expect(h.controller.state().phase).toBe('ready')
    expect(h.controller.markSaved(currentCommand, '/tmp/installer')).toBe(true)
    expect(h.controller.state().phase).toBe('saved')
    expect(h.controller.downloadedPath()).toBeNull()

    h.controller.dispose()
    await h.controller.resourcesSettled()
    expect(release).not.toHaveBeenCalled()
  })

  it('lets dismiss win while saved-product preparation is awaiting', async () => {
    const prepare = deferred<void>()
    const release = vi.fn(async () => {})
    const reveal = vi.fn()
    const h = harness({ release })
    await h.controller.check(true)
    await h.controller.download(h.controller.snapshot().commandId)
    const commandId = h.controller.snapshot().commandId
    const saving = prepareSavedProduct(h.controller, commandId, '/tmp/installer', {
      prepare: () => prepare.promise,
      reveal
    })

    h.controller.dismiss(commandId)
    prepare.resolve()
    await expect(saving).resolves.toBe(false)
    expect(reveal).not.toHaveBeenCalled()
    await h.controller.resourcesSettled()
    expect(release).toHaveBeenCalledWith('/tmp/installer')
    expect(h.controller.state().phase).toBe('idle')
  })

  it('reveals a prepared product before transferring it to the user', async () => {
    const order: string[] = []
    const release = vi.fn(async () => {})
    const h = harness({ release })
    await h.controller.check(true)
    await h.controller.download(h.controller.snapshot().commandId)
    const commandId = h.controller.snapshot().commandId

    await expect(
      prepareSavedProduct(h.controller, commandId, '/tmp/installer', {
        prepare: async () => {
          order.push('prepared')
        },
        reveal: () => order.push('revealed')
      })
    ).resolves.toBe(true)
    expect(order).toEqual(['prepared', 'revealed'])
    expect(h.controller.state().phase).toBe('saved')
    h.controller.dispose()
    await h.controller.resourcesSettled()
    expect(release).not.toHaveBeenCalled()
  })

  it('keeps a product owned and ready when preparation fails', async () => {
    const reveal = vi.fn()
    const h = harness()
    await h.controller.check(true)
    await h.controller.download(h.controller.snapshot().commandId)
    const commandId = h.controller.snapshot().commandId

    await expect(
      prepareSavedProduct(h.controller, commandId, '/tmp/installer', {
        prepare: async () => {
          throw new Error('preparation failed')
        },
        reveal
      })
    ).rejects.toThrow('preparation failed')
    expect(reveal).not.toHaveBeenCalled()
    expect(h.controller.state().phase).toBe('ready')
    expect(h.controller.downloadedPath()).toBe('/tmp/installer')
  })

  it('lets disposal win while saved-product preparation is awaiting', async () => {
    const prepare = deferred<void>()
    const release = vi.fn(async () => {})
    const reveal = vi.fn()
    const h = harness({ release })
    await h.controller.check(true)
    await h.controller.download(h.controller.snapshot().commandId)
    const saving = prepareSavedProduct(
      h.controller,
      h.controller.snapshot().commandId,
      '/tmp/installer',
      { prepare: () => prepare.promise, reveal }
    )

    h.controller.dispose()
    prepare.resolve()
    await expect(saving).resolves.toBe(false)
    await h.controller.resourcesSettled()
    expect(reveal).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledWith('/tmp/installer')
  })

  it('releases a stale successful download returned after cancellation', async () => {
    const result = deferred<string | null>()
    const release = vi.fn(async () => {})
    const h = harness({ download: async () => result.promise, release })
    await h.controller.check(true)
    const downloading = h.controller.download(h.controller.snapshot().commandId)
    h.controller.cancelDownload(h.controller.snapshot().commandId)
    result.resolve('/tmp/stale')
    await downloading
    await h.controller.resourcesSettled()
    expect(release).toHaveBeenCalledWith('/tmp/stale')
  })

  it('does not let the pre-download card skip an already-started command', async () => {
    const result = deferred<string | null>()
    const release = vi.fn(async () => {})
    const save = vi.fn(async () => {})
    let signal: AbortSignal | null = null
    const h = harness({
      download: async (_update, nextSignal) => {
        signal = nextSignal
        return result.promise
      },
      release,
      save
    })
    await h.controller.check(true)
    const availableCommand = h.controller.snapshot().commandId
    const downloading = h.controller.download(availableCommand)
    await Promise.resolve()

    h.controller.skip(update.version, availableCommand)
    expect(signal?.aborted).toBe(false)
    expect(h.controller.state().phase).toBe('downloading')
    expect(save).not.toHaveBeenCalled()
    result.resolve('/tmp/current')
    await downloading
    await h.controller.resourcesSettled()
    expect(release).not.toHaveBeenCalled()
    expect(h.controller.downloadedPath()).toBe('/tmp/current')
  })

  it('does not let an old same-version skip abort a newer download command', async () => {
    const result = deferred<string | null>()
    const save = vi.fn(async () => {})
    let signal: AbortSignal | null = null
    const h = harness({
      save,
      download: async (_update, nextSignal) => {
        signal = nextSignal
        return result.promise
      }
    })
    await h.controller.check(true)
    const staleCommand = h.controller.snapshot().commandId
    await h.controller.check(true)
    const downloading = h.controller.download(h.controller.snapshot().commandId)
    await Promise.resolve()

    h.controller.skip(update.version, staleCommand)
    expect(signal?.aborted).toBe(false)
    expect(h.controller.state().phase).toBe('downloading')
    expect(save).not.toHaveBeenCalled()

    result.resolve('/tmp/current')
    await downloading
    expect(h.controller.state().phase).toBe('ready')
    expect(h.controller.downloadedPath()).toBe('/tmp/current')
  })

  it('ignores a delayed skip for a version that no longer owns update state', async () => {
    const release = vi.fn(async () => {})
    const h = harness({ release })
    await h.controller.check(true)
    await h.controller.download(h.controller.snapshot().commandId)

    h.controller.skip('1.9.0', h.controller.snapshot().commandId)
    expect(h.controller.state()).toMatchObject({ phase: 'ready', info: { version: '2.0.0' } })
    expect(h.controller.downloadedPath()).toBe('/tmp/installer')
    expect(release).not.toHaveBeenCalled()
  })

  it('waits for an in-flight disposed download before reporting resources settled', async () => {
    const result = deferred<string | null>()
    const release = vi.fn(async () => {})
    const h = harness({ download: async () => result.promise, release })
    await h.controller.check(true)
    void h.controller.download(h.controller.snapshot().commandId)
    await Promise.resolve()
    h.controller.dispose()
    const settled = h.controller.resourcesSettled()
    result.resolve('/tmp/disposed-late')
    await settled
    expect(release).toHaveBeenCalledWith('/tmp/disposed-late')
  })
})

describe('update temporary-resource cleanup', () => {
  it('waits for output close before removing a failed download directory', async () => {
    let close: (() => void) | null = null
    const order: string[] = []
    const output = {
      closed: false,
      once: vi.fn((_event: 'close', listener: () => void) => {
        order.push('listening')
        close = listener
      }),
      destroy: vi.fn(() => {
        order.push('destroyed')
      })
    }
    const cleanup = releaseFailedDownload(output, async () => {
      order.push('removed')
    })

    await Promise.resolve()
    expect(order).toEqual(['listening', 'destroyed'])
    expect(output.once).toHaveBeenCalledWith('close', expect.any(Function))
    expect(output.destroy).toHaveBeenCalledTimes(1)
    expect(close).not.toBeNull()
    close!()
    await cleanup
    expect(order).toEqual(['listening', 'destroyed', 'removed'])
  })

  it.each(['settings', 'resources'] as const)(
    'waits when %s settles first, then retries retained cleanup before ready',
    async (firstBarrier) => {
      let attempts = 0
      const retry = deferred<void>()
      const settings = deferred<void>()
      const resourcesReady = deferred<void>()
      const remove = vi.fn(async () => {
        if (++attempts === 1) throw new Error('busy')
        await retry.promise
      })
      const cleanup = new RetainedCleanup(remove)
      // The controller's resource settlement creates this retained key. Cleanup
      // must take its pending snapshot only after BOTH controller barriers.
      const resources = resourcesReady.promise.then(() => cleanup.release('/tmp/product'))
      const markReady = vi.fn()
      const shutdown = settleUpdateShutdown(settings.promise, resources, cleanup, markReady)

      if (firstBarrier === 'settings') settings.resolve()
      else resourcesReady.resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(remove).toHaveBeenCalledTimes(firstBarrier === 'resources' ? 1 : 0)
      expect(markReady).not.toHaveBeenCalled()

      if (firstBarrier === 'settings') resourcesReady.resolve()
      else settings.resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(remove).toHaveBeenCalledTimes(2)
      expect(cleanup.pendingCount()).toBe(1)
      expect(markReady).not.toHaveBeenCalled()
      retry.resolve()
      await shutdown
      expect(cleanup.pendingCount()).toBe(0)
      expect(markReady).toHaveBeenCalledTimes(1)
    }
  )
})

describe('update quit coordination', () => {
  it('holds and coalesces quit until shutdown settles, then finalizes once', async () => {
    const coordinator = new AsyncQuitCoordinator()
    const shutdownDone = deferred<void>()
    const shutdown = vi.fn(() => shutdownDone.promise)
    const retry = vi.fn()
    const first = { preventDefault: vi.fn() }
    const repeated = { preventDefault: vi.fn() }

    expect(coordinator.allowsWindowCreation()).toBe(true)
    expect(shouldCreateWindowOnActivate(0, coordinator.allowsWindowCreation())).toBe(true)
    expect(coordinator.intercept(first, shutdown, retry)).toBe(true)
    expect(coordinator.allowsWindowCreation()).toBe(false)
    expect(shouldCreateWindowOnActivate(0, coordinator.allowsWindowCreation())).toBe(false)
    expect(coordinator.intercept(repeated, shutdown, retry)).toBe(true)
    expect(first.preventDefault).toHaveBeenCalledTimes(1)
    expect(repeated.preventDefault).toHaveBeenCalledTimes(1)
    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(retry).not.toHaveBeenCalled()

    shutdownDone.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(retry).toHaveBeenCalledTimes(1)
    const final = { preventDefault: vi.fn() }
    expect(coordinator.intercept(final, shutdown, retry)).toBe(false)
    expect(coordinator.allowsWindowCreation()).toBe(false)
    expect(shouldCreateWindowOnActivate(0, coordinator.allowsWindowCreation())).toBe(false)
    expect(final.preventDefault).not.toHaveBeenCalled()
    expect(shutdown).toHaveBeenCalledTimes(1)
  })

  it('performs the final exit even when installer hand-off throws', () => {
    const order: string[] = []
    finalizeApplicationExit(
      () => {
        order.push('handoff')
        throw new Error('launch failed')
      },
      () => order.push('exit')
    )

    expect(order).toEqual(['handoff', 'exit'])
  })

  it('waits for every accepted adapter task, including rejection', async () => {
    const tasks = new PendingTasks()
    const success = deferred<void>()
    const failure = deferred<void>()
    tasks.track(success.promise)
    tasks.track(failure.promise.then(() => Promise.reject(new Error('failed'))))
    let settled = false
    const waiting = tasks.settle().then(() => {
      settled = true
    })

    await Promise.resolve()
    expect(settled).toBe(false)
    success.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    failure.resolve()
    await waiting
    expect(settled).toBe(true)
  })

  it('hands an armed installer to the ready final exit exactly once', () => {
    const installer = new FinalQuitInstaller()
    const handoff = vi.fn(() => true)
    installer.arm('/tmp/installer')
    installer.prepare(handoff)

    expect(handoff).toHaveBeenCalledWith('/tmp/installer')
    expect(installer.take()).toBeNull()
    installer.markReady()
    expect(installer.take()).toBe('/tmp/installer')
    expect(installer.take()).toBeNull()
  })

  it('finalizes exit even when shutdown rejects', async () => {
    const coordinator = new AsyncQuitCoordinator()
    const retry = vi.fn()
    coordinator.intercept(
      { preventDefault: vi.fn() },
      async () => {
        throw new Error('cleanup failed')
      },
      retry
    )
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('does not hand off a cancelled or unowned installer', () => {
    const cancelled = new FinalQuitInstaller()
    const handoff = vi.fn(() => true)
    cancelled.arm('/tmp/cancelled')
    cancelled.cancel()
    cancelled.prepare(handoff)
    cancelled.markReady()
    expect(handoff).not.toHaveBeenCalled()
    expect(cancelled.take()).toBeNull()

    const rejected = new FinalQuitInstaller()
    rejected.arm('/tmp/rejected')
    rejected.prepare(() => false)
    rejected.markReady()
    expect(rejected.take()).toBeNull()
  })
})
