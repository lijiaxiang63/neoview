import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAppStore, type AppStore } from '../src/renderer/src/store'
import { RegionExportController } from '../src/renderer/src/runtime/regionExportController'
import type { Volume } from '../src/renderer/src/volume/types'

let store: AppStore

beforeEach(() => {
  store = createAppStore({ storage: null, pagehideTarget: null })
})

afterEach(() => store.dispose())

function volume(): Volume {
  return {
    name: 'a.nii',
    dims: [1, 1, 1],
    frames: 1,
    spacing: [1, 1, 1],
    affine: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    datatypeCode: 2,
    slope: 1,
    inter: 0,
    stats: { dataMin: 0, dataMax: 1, p2: 0, p98: 1, typeRange: [0, 255] }
  } as Volume
}

describe('RegionExportController', () => {
  it('owns settings, worker build, bridge write and completion feedback', async () => {
    const memory = new Map<string, string>([['neoview.export.dir', '/out']])
    const storage = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => void memory.set(key, value)
    }
    const client = {
      build: vi.fn(async () => ({
        fileName: 'a.regions.nii.gz',
        bytes: new ArrayBuffer(1),
        sidecar: null
      })),
      dispose: vi.fn()
    }
    const bridge = {
      exportFile: vi.fn(async () => ({ path: '/out/a.regions.nii.gz', sidecarPath: null })),
      pickDirectory: vi.fn(async () => '/chosen')
    }
    const controller = new RegionExportController({ store, bridge, storage, client })
    store.getState().setVolume(volume(), '/source/a.nii')
    store.setState({ labelMap: new Uint16Array([1]), segDirty: true, segRevision: 3 })

    await expect(controller.export('labels')).resolves.toBe(true)
    expect(client.build).toHaveBeenCalledOnce()
    expect(bridge.exportFile).toHaveBeenCalledWith(
      expect.objectContaining({ dir: '/out', fileName: 'a.regions.nii.gz' })
    )
    expect(store.getState().segDirty).toBe(false)
    expect(store.getState().toasts.at(-1)?.action).toMatchObject({ kind: 'reveal' })

    await controller.pickDirectory()
    expect(controller.getSnapshot().settings.dir).toBe('/chosen')
    controller.dispose()
    expect(client.dispose).toHaveBeenCalledOnce()
  })

  it('reports a missing destination without starting worker work', async () => {
    const client = { build: vi.fn(), dispose: vi.fn() }
    const controller = new RegionExportController({
      store,
      bridge: { exportFile: vi.fn(), pickDirectory: vi.fn() },
      storage: { getItem: () => null, setItem: vi.fn() },
      client
    })
    store.getState().setVolume(volume())
    store.setState({ labelMap: new Uint16Array([1]) })

    await expect(controller.export('mask')).resolves.toBe(false)
    expect(client.build).not.toHaveBeenCalled()
    expect(store.getState().errorMessage).toContain('pick an export folder')
    controller.dispose()
  })
})
