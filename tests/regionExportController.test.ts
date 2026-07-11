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
    raw: new Uint8Array([1]),
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

  it('saves, adds the generated result as a layer, then clears the exported state', async () => {
    const bytes = new ArrayBuffer(4)
    const client = {
      build: vi.fn(async () => ({
        fileName: 'a.regions.nii.gz',
        bytes,
        sidecar: { fileName: 'a.regions.txt', text: '1\t10\t20\t30\t255\tTarget\n' }
      })),
      dispose: vi.fn()
    }
    const layer = volume()
    layer.name = 'a.regions-2.nii.gz'
    const loadVolume = vi.fn(async () => layer)
    const controller = new RegionExportController({
      store,
      bridge: {
        exportFile: vi.fn(async () => ({
          path: '/out/a.regions-2.nii.gz',
          sidecarPath: '/out/a.regions-2.txt'
        })),
        pickDirectory: vi.fn()
      },
      storage: { getItem: () => '/out', setItem: vi.fn() },
      client,
      loadVolume
    })
    store.getState().setVolume(volume(), '/source/a.nii')
    store.setState({
      labelMap: new Uint16Array([1]),
      regions: [
        {
          id: 1,
          name: 'Target',
          color: '#0a141e',
          visible: true,
          voxelCount: 1,
          stats: null
        }
      ],
      nextRegionId: 2,
      segDirty: true,
      segRevision: 4
    })

    await controller.exportToLayerAndClear()

    expect(loadVolume).toHaveBeenCalledWith('a.regions-2.nii.gz', bytes, expect.any(Object))
    expect(store.getState().overlays[0]).toMatchObject({
      sourcePath: '/out/a.regions-2.nii.gz',
      kind: 'labels'
    })
    expect(store.getState().overlays[0].labelTable?.get(1)).toEqual({
      name: 'Target',
      rgba: [10, 20, 30, 255]
    })
    expect(store.getState()).toMatchObject({
      labelMap: null,
      regions: [],
      segDirty: false,
      sidePanelTab: 'layers'
    })
    store.getState().undo()
    expect(store.getState().regions).toHaveLength(1)
    expect(store.getState().segDirty).toBe(false)
    controller.dispose()
  })

  it('keeps newer region state when ownership changes during layer preparation', async () => {
    let resolveLayer!: (value: Volume) => void
    let layerSignal: AbortSignal | null = null
    const preparing = new Promise<Volume>((resolve) => {
      resolveLayer = resolve
    })
    const controller = new RegionExportController({
      store,
      bridge: {
        exportFile: vi.fn(async () => ({
          path: '/out/a.regions.nii',
          sidecarPath: '/out/a.regions.txt'
        })),
        pickDirectory: vi.fn()
      },
      storage: { getItem: () => '/out', setItem: vi.fn() },
      client: {
        build: vi.fn(async () => ({
          fileName: 'a.regions.nii',
          bytes: new ArrayBuffer(1),
          sidecar: { fileName: 'a.regions.txt', text: '1\t1\t2\t3\t255\tOld\n' }
        })),
        dispose: vi.fn()
      },
      loadVolume: vi.fn((_name, _bytes, options) => {
        layerSignal = options.signal
        return preparing
      })
    })
    store.getState().setVolume(volume(), '/source/a.nii')
    store.setState({ labelMap: new Uint16Array([1]), segDirty: true, segRevision: 2 })

    const pending = controller.exportToLayerAndClear()
    await vi.waitFor(() => expect(layerSignal).not.toBeNull())
    store.setState({ segRevision: 3, segDirty: true })
    expect(layerSignal?.aborted).toBe(true)
    resolveLayer(volume())
    await pending

    expect(store.getState().labelMap).not.toBeNull()
    expect(store.getState().overlays).toEqual([])
    expect(store.getState().segDirty).toBe(true)
    controller.dispose()
  })
})
