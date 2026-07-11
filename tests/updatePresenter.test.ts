import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UpdateSnapshot } from '../src/shared/updates'
import {
  UpdatePresenter,
  type UpdatePresenterBridge
} from '../src/renderer/src/runtime/updatePresenter'

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function bridge(query: Promise<UpdateSnapshot>): {
  value: UpdatePresenterBridge
  emit(snapshot: UpdateSnapshot): void
} {
  let listener: ((snapshot: UpdateSnapshot) => void) | null = null
  const value: UpdatePresenterBridge = {
    platform: 'darwin',
    getUpdateState: () => query,
    onUpdateState: (callback) => {
      listener = callback
      return () => {
        listener = null
      }
    },
    downloadUpdate: vi.fn(async () => null),
    installUpdate: vi.fn(async () => ({ quits: false })),
    cancelUpdateDownload: vi.fn(),
    skipUpdateVersion: vi.fn(),
    dismissUpdate: vi.fn()
  }
  return {
    value,
    emit: (snapshot: UpdateSnapshot) => listener?.(snapshot)
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('UpdatePresenter', () => {
  it('keeps a newer event when the initial query resolves late', async () => {
    const query = deferred<UpdateSnapshot>()
    const h = bridge(query.promise)
    const presenter = new UpdatePresenter({ bridge: h.value, openExternal: vi.fn() })
    presenter.init()
    h.emit({
      revision: 2,
      commandId: 4,
      state: {
        phase: 'saved',
        info: {
          version: '2.0.0',
          notesUrl: 'https://example.com',
          assetName: 'a',
          assetSize: 1
        }
      }
    })
    query.resolve({ revision: 1, commandId: 3, state: { phase: 'idle' } })
    await Promise.resolve()

    expect(presenter.getSnapshot().update.revision).toBe(2)
    presenter.dispose()
  })

  it('publishes a command-owned transport fallback and releases the latch', async () => {
    const current: UpdateSnapshot = {
      revision: 1,
      commandId: 7,
      state: {
        phase: 'available',
        info: {
          version: '2.0.0',
          notesUrl: 'https://example.com',
          assetName: 'a',
          assetSize: 1
        },
        error: null
      }
    }
    const h = bridge(Promise.resolve(current))
    h.value.downloadUpdate = vi.fn(async () => {
      throw new Error("Error invoking remote method 'update-download': Error: offline")
    })
    const presenter = new UpdatePresenter({ bridge: h.value, openExternal: vi.fn() })
    presenter.init()
    await Promise.resolve()
    if (current.state.phase !== 'available') throw new Error('invalid fixture')
    const info = current.state.info
    await presenter.download(info, current)

    expect(presenter.getSnapshot()).toMatchObject({
      commandPending: false,
      update: { state: { phase: 'available', error: 'offline' } }
    })
    presenter.dispose()
  })

  it('owns result auto-dismiss timing outside React', async () => {
    vi.useFakeTimers()
    const current: UpdateSnapshot = {
      revision: 1,
      commandId: 2,
      state: { phase: 'none', version: '1.0.0' }
    }
    const h = bridge(Promise.resolve(current))
    const presenter = new UpdatePresenter({ bridge: h.value, openExternal: vi.fn() })
    presenter.init()
    await Promise.resolve()
    vi.advanceTimersByTime(6000)
    expect(h.value.dismissUpdate).toHaveBeenCalledWith(2)
    presenter.dispose()
  })
})
