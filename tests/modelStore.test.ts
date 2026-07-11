import { describe, expect, it, vi } from 'vitest'
import type { ModelController, ModelRunCallbacks } from '../src/renderer/src/model/modelRunner'
import type { ModelVariantId } from '../src/renderer/src/model/catalog'
import { createAppStore } from '../src/renderer/src/store'
import type { Volume } from '../src/renderer/src/volume/types'

const IDENTITY = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])

function volume(patch: Partial<Volume> = {}): Volume {
  return {
    name: 'v',
    dims: [2, 2, 2],
    frames: 1,
    spacing: [1, 1, 1],
    datatypeCode: 2,
    datatypeName: 'uint8',
    raw: new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]),
    slope: 1,
    inter: 0,
    affine: IDENTITY.slice(),
    transformSource: 'rows',
    suggestedRange: null,
    labels: null,
    stats: { dataMin: 0, dataMax: 7, p2: 0, p98: 7, typeRange: [0, 255] },
    ...patch
  }
}

class FakeController implements ModelController {
  callbacks: ModelRunCallbacks | null = null
  cancel = vi.fn()
  dispose = vi.fn()

  availability(): { available: true; reason: null } {
    return { available: true, reason: null }
  }

  run(
    _token: number,
    _volumeSession: number,
    _variantId: ModelVariantId,
    _volume: Volume,
    callbacks: ModelRunCallbacks
  ): boolean {
    this.callbacks = callbacks
    return true
  }
}

describe('model state ownership', () => {
  it('publishes progress and preview without making the region state dirty', () => {
    const controller = new FakeController()
    const store = createAppStore({
      storage: null,
      pagehideTarget: null,
      createModelController: () => controller
    })
    store.getState().setVolume(volume())
    store.getState().startModelRun()
    expect(store.getState().modelRun.status).toBe('running')
    controller.callbacks?.progress(0.5, 'infer')
    expect(store.getState().modelRun.progress).toBe(0.5)
    controller.callbacks?.progress(0.25, 'load')
    expect(store.getState().modelRun.progress).toBe(0.5)
    expect(store.getState().modelRun.stage).toBe('infer')
    const labels = new Uint8Array([0, 1, 1, 2, 2, 2, 0, 0])
    controller.callbacks?.complete(labels, new Uint32Array([3, 2, 3]))
    expect(store.getState().modelRun.status).toBe('preview')
    expect(store.getState().segDirty).toBe(false)
    expect(store.getState().labelMap).toBeNull()
    store.dispose()
    expect(controller.dispose).toHaveBeenCalledTimes(1)
  })

  it('cancels an owned run when the base volume changes', () => {
    const controller = new FakeController()
    const store = createAppStore({
      storage: null,
      pagehideTarget: null,
      createModelController: () => controller
    })
    store.getState().setVolume(volume())
    store.getState().startModelRun()
    store.getState().setVolume(volume())
    expect(controller.cancel).toHaveBeenCalled()
    expect(store.getState().modelRun.status).toBe('idle')
    store.dispose()
  })

  it('retains the selected mode across base volume changes and discards an old preview on switch', () => {
    const controller = new FakeController()
    const store = createAppStore({
      storage: null,
      pagehideTarget: null,
      createModelController: () => controller
    })
    store.getState().setVolume(volume())
    store.getState().setModelVariant('subcortical-low')
    store.getState().startModelRun()
    const counts = new Uint32Array(18)
    counts[0] = 8
    controller.callbacks?.complete(new Uint8Array(8), counts)
    expect(store.getState().modelRun.status).toBe('preview')
    store.getState().setModelVariant('aparc-104-low')
    expect(store.getState().modelRun.status).toBe('idle')
    expect(store.getState().selectedModelVariantId).toBe('aparc-104-low')
    store.getState().setVolume(volume())
    expect(store.getState().selectedModelVariantId).toBe('aparc-104-low')
    store.dispose()
  })

  it('retains the worker error code so only execution failures can offer a lower-memory mode', () => {
    const controller = new FakeController()
    const store = createAppStore({
      storage: null,
      pagehideTarget: null,
      createModelController: () => controller
    })
    store.getState().setVolume(volume())
    store.getState().startModelRun()
    controller.callbacks?.error('asset-invalid', 'invalid')
    expect(store.getState().modelRun).toMatchObject({
      status: 'error',
      error: 'invalid',
      errorCode: 'asset-invalid'
    })
    store.dispose()
  })

  it('commits all 103 nonzero classes from the largest catalog', () => {
    const controller = new FakeController()
    const store = createAppStore({
      storage: null,
      pagehideTarget: null,
      createModelController: () => controller
    })
    const source = volume({ dims: [103, 1, 1], raw: new Uint8Array(103) })
    store.getState().setVolume(source)
    store.getState().setModelVariant('aparc-104-low')
    store.getState().startModelRun()
    const labels = Uint8Array.from({ length: 103 }, (_, index) => index + 1)
    const counts = new Uint32Array(104)
    counts.fill(1, 1)
    controller.callbacks?.complete(labels, counts)
    store.getState().commitModelPreview()
    expect(store.getState().regions).toHaveLength(103)
    expect(store.getState().nextRegionId).toBe(104)
    expect(store.getState().segRevision).toBe(1)
    expect(Array.from(store.getState().labelMap!)).toEqual(
      Array.from({ length: 103 }, (_, index) => index + 1)
    )
    store.dispose()
  })

  it('cancels running and preview state before direct region re-edit', () => {
    const controller = new FakeController()
    const store = createAppStore({
      storage: null,
      pagehideTarget: null,
      createModelController: () => controller
    })
    store.getState().setVolume(volume())
    store.setState({
      labelMap: new Uint16Array([1, 0, 0, 0, 0, 0, 0, 0]),
      regions: [
        {
          id: 1,
          name: 'Region 1',
          color: '#ff0000',
          visible: true,
          voxelCount: 1,
          stats: null
        }
      ]
    })
    controller.cancel.mockClear()

    store.getState().startModelRun()
    const runningCallbacks = controller.callbacks!
    store.getState().editRegion(1)
    expect(store.getState().modelRun.status).toBe('idle')
    runningCallbacks.complete(new Uint8Array(8), new Uint32Array([8, 0, 0]))
    expect(store.getState().modelRun.status).toBe('idle')

    store.getState().startModelRun()
    controller.callbacks?.complete(
      new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0]),
      new Uint32Array([7, 1, 0])
    )
    expect(store.getState().modelRun.status).toBe('preview')
    store.getState().editRegion(1)
    expect(store.getState().modelRun.status).toBe('idle')
    expect(controller.cancel).toHaveBeenCalledTimes(2)
    store.dispose()
  })

  it('atomically replaces regions and restores both maps with one undo and redo', () => {
    const controller = new FakeController()
    const confirm = vi.fn(() => true)
    const store = createAppStore({
      storage: null,
      pagehideTarget: null,
      createModelController: () => controller,
      confirmModelReplace: confirm
    })
    store.getState().setVolume(volume())
    const oldMap = new Uint16Array([1, 0, 0, 0, 0, 0, 0, 0])
    store.setState({
      labelMap: oldMap,
      regions: [
        {
          id: 1,
          name: 'Region 1',
          color: '#ff0000',
          visible: true,
          voxelCount: 1,
          stats: { min: 0, max: 0, mean: 0 }
        }
      ],
      nextRegionId: 2,
      activeRegionId: 1
    })
    store.getState().startModelRun()
    controller.callbacks?.complete(
      new Uint8Array([0, 1, 1, 2, 2, 2, 0, 0]),
      new Uint32Array([3, 2, 3])
    )
    store.getState().commitModelPreview()
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(store.getState().regions.map((region) => region.name)).toEqual([
      'White Matter',
      'Grey Matter'
    ])
    expect(Array.from(store.getState().labelMap!)).toEqual([0, 2, 2, 3, 3, 3, 0, 0])
    expect(store.getState().nextRegionId).toBe(4)
    expect(store.getState().undoStack).toHaveLength(1)

    store.getState().undo()
    expect(store.getState().labelMap).toBe(oldMap)
    expect(store.getState().regions.map((region) => region.id)).toEqual([1])
    expect(store.getState().activeRegionId).toBe(1)
    expect(store.getState().nextRegionId).toBe(2)

    store.getState().redo()
    expect(Array.from(store.getState().labelMap!)).toEqual([0, 2, 2, 3, 3, 3, 0, 0])
    expect(store.getState().regions.map((region) => region.id)).toEqual([2, 3])
    store.dispose()
  })

  it('keeps the preview unchanged when replacement confirmation is declined', () => {
    const controller = new FakeController()
    const store = createAppStore({
      storage: null,
      pagehideTarget: null,
      createModelController: () => controller,
      confirmModelReplace: () => false
    })
    store.getState().setVolume(volume())
    store.setState({ labelMap: new Uint16Array(8), regions: [] })
    store.getState().startModelRun()
    controller.callbacks?.complete(
      new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0]),
      new Uint32Array([7, 1, 0])
    )
    store.getState().commitModelPreview()
    expect(store.getState().modelRun.status).toBe('preview')
    expect(store.getState().segDirty).toBe(false)
    store.dispose()
  })
})
