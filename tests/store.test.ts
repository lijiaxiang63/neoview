import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BRIGHTNESS_DEFAULT,
  BRIGHTNESS_MAX,
  BRIGHTNESS_MIN,
  createAppStore,
  DENSITY_MAX,
  DENSITY_MIN,
  floodCap,
  hasUnsavedRegions,
  pickInitialPreset,
  presetRange,
  REGION_STATS_DEBOUNCE_MS,
  type AppStore,
  type PagehideTarget,
  type PreviewController,
  type SegParams
} from '../src/renderer/src/store'
import { MAX_RESULT_VOXELS, type SegBox } from '../src/renderer/src/segmentation/segment'
import { loadViewPref } from '../src/renderer/src/files/viewPrefs'
import type { Volume, VolumeStats } from '../src/renderer/src/volume/types'

let useStore: AppStore

beforeEach(() => {
  useStore = createAppStore({ storage: null, pagehideTarget: null })
})

afterEach(() => {
  useStore.dispose()
  vi.useRealTimers()
})

function fakeVolume(stats: Partial<VolumeStats>, datatypeCode = 4): Volume {
  return {
    datatypeCode,
    suggestedRange: null,
    slope: 1,
    inter: 0,
    stats: {
      dataMin: 0,
      dataMax: 100,
      p2: 1,
      p98: 99,
      typeRange: null,
      ...stats
    }
  } as Volume
}

function baseVolume(): Volume {
  const vol = fakeVolume({ dataMin: 0, dataMax: 100, p2: 5, p98: 95 })
  ;(vol as { dims: number[] }).dims = [4, 4, 4]
  return vol
}

describe('pickInitialPreset', () => {
  it('degenerate percentiles -> full', () => {
    expect(pickInitialPreset(fakeVolume({ p2: 5, p98: 5 }))).toBe('full')
  })

  it('deep negative floor with wide positive extent -> fixed 0-80', () => {
    const vol = fakeVolume({ dataMin: -1024, dataMax: 1500, p2: -1000, p98: 900 })
    expect(pickInitialPreset(vol)).toBe('fixed-0-80')
    expect(presetRange(vol, 'fixed-0-80')).toEqual({ lo: 0, hi: 80 })
  })

  it('floor below the calibrated plateau -> not the fixed window', () => {
    const vol = fakeVolume({ dataMin: -32768, dataMax: 1500, p2: -1000, p98: 900 })
    expect(pickInitialPreset(vol)).toBe('auto')
  })

  it('wide uint8 data -> full', () => {
    const vol = fakeVolume({ dataMin: 0, dataMax: 255, p2: 4, p98: 250, typeRange: [0, 255] }, 2)
    expect(pickInitialPreset(vol)).toBe('full')
    expect(presetRange(vol, 'full')).toEqual({ lo: 0, hi: 255 })
  })

  it('everything else -> auto percentile range', () => {
    const vol = fakeVolume({ dataMin: 0, dataMax: 4000, p2: 20, p98: 2200 })
    expect(pickInitialPreset(vol)).toBe('auto')
    expect(presetRange(vol, 'auto')).toEqual({ lo: 20, hi: 2200 })
  })
})

describe('store instances and lifecycle', () => {
  it('advances a lightweight volume session on every base replacement', () => {
    const first = baseVolume()
    const second = baseVolume()
    expect(useStore.getState().volumeSession).toBe(0)
    useStore.getState().setVolume(first)
    expect(useStore.getState().volumeSession).toBe(1)
    useStore.getState().setVolume(second)
    expect(useStore.getState().volumeSession).toBe(2)
    expect(useStore.getState().volume).toBe(second)
  })

  it('keeps state, ids, and subscriptions isolated between two instances', () => {
    const a = createAppStore({ storage: null, pagehideTarget: null })
    const b = createAppStore({ storage: null, pagehideTarget: null })
    try {
      expect(a.getState().segParams).not.toBe(b.getState().segParams)
      expect(a.getState().exportedPaths).not.toBe(b.getState().exportedPaths)

      const onA = vi.fn()
      const unsubscribe = a.subscribe(onA)
      b.getState().setDensity(0.8)
      expect(onA).not.toHaveBeenCalled()
      a.getState().setDensity(0.6)
      expect(onA).toHaveBeenCalledTimes(1)
      unsubscribe()

      a.getState().setVolume(baseVolume())
      b.getState().setVolume(baseVolume())
      const layer = fakeVolume({ dataMin: 0, dataMax: 1, typeRange: [0, 255] }, 2)
      a.getState().addOverlay(layer)
      b.getState().addOverlay(layer)
      expect(a.getState().overlays[0].id).toBe(1)
      expect(b.getState().overlays[0].id).toBe(1)

      expect(a.getState().pushToast({ text: 'a' })).toBe(0)
      expect(b.getState().pushToast({ text: 'b' })).toBe(0)
      expect(a.getState().toasts.map((t) => t.text)).toEqual(['a'])
      expect(b.getState().toasts.map((t) => t.text)).toEqual(['b'])
    } finally {
      a.dispose()
      b.dispose()
    }
  })

  it('dispose flushes prefs and releases timers, subscriptions, pagehide, and preview', () => {
    vi.useFakeTimers()
    const mem = new Map<string, string>()
    const storage = {
      getItem: (key: string): string | null => mem.get(key) ?? null,
      setItem: vi.fn((key: string, value: string) => void mem.set(key, value))
    }
    const addEventListener = vi.fn()
    const removeEventListener = vi.fn()
    const pagehideTarget: PagehideTarget = { addEventListener, removeEventListener }
    const controller: PreviewController = {
      available: () => false,
      reset: vi.fn(),
      dropOverlay: vi.fn(),
      request: (() => false) as PreviewController['request'],
      dispose: vi.fn()
    }
    const owned = createAppStore({
      storage,
      pagehideTarget,
      createPreviewController: () => controller
    })

    owned.getState().setVolume(baseVolume(), '/data/a')
    owned.getState().setRange(5, 50)
    owned.getState().setSegBox({ min: [0, 0, 0], max: [1, 1, 1] })
    expect(vi.getTimerCount()).toBe(2)
    const subscriber = vi.fn()
    owned.subscribe(subscriber)

    owned.dispose()
    expect(vi.getTimerCount()).toBe(0)
    expect(loadViewPref('/data/a', storage)).toEqual({ preset: 'custom', lo: 5, hi: 50 })
    expect(controller.dispose).toHaveBeenCalledTimes(1)
    expect(removeEventListener).toHaveBeenCalledWith('pagehide', addEventListener.mock.calls[0][1])
    const densityAtDispose = owned.getState().density
    owned.setState({ density: 0.8 })
    owned.getState().setDensity(0.9)
    expect(subscriber).not.toHaveBeenCalled()
    expect(owned.getState().density).toBe(densityAtDispose)

    // Teardown is idempotent; a StrictMode/HMR cleanup cannot release twice.
    owned.dispose()
    expect(controller.dispose).toHaveBeenCalledTimes(1)
    expect(removeEventListener).toHaveBeenCalledTimes(1)
  })

  it('routes async preview results only to their owning live instance', () => {
    vi.useFakeTimers()
    type ResultCallback = Parameters<PreviewController['request']>[5]
    const pendingA: { token: number; callback: ResultCallback }[] = []
    const pendingB: { token: number; callback: ResultCallback }[] = []
    const controller = (
      pending: { token: number; callback: ResultCallback }[]
    ): PreviewController => ({
      available: () => true,
      reset: vi.fn(),
      dropOverlay: vi.fn(),
      request: (_vol, _labelMap, _labelMapRev, _overlays, req, callback) => {
        pending.push({ token: req.token, callback })
        return true
      },
      dispose: vi.fn()
    })
    const a = createAppStore({
      storage: null,
      pagehideTarget: null,
      createPreviewController: () => controller(pendingA)
    })
    const b = createAppStore({
      storage: null,
      pagehideTarget: null,
      createPreviewController: () => controller(pendingB)
    })
    try {
      const side = 2048
      const largeVolume = (): Volume => ({
        ...baseVolume(),
        dims: [side, side, 1],
        frames: 1,
        raw: new Uint8Array(side * side)
      })
      a.getState().setVolume(largeVolume())
      b.getState().setVolume(largeVolume())
      const box: SegBox = { min: [0, 0, 0], max: [side - 1, side - 1, 0] }
      a.getState().setSegBox(box)
      b.getState().setSegBox(box)
      vi.advanceTimersByTime(90)
      expect(pendingA).toHaveLength(1)
      expect(pendingB).toHaveLength(1)

      const result = {
        mask: new Uint8Array([1]),
        bounds: { min: [0, 0, 0], max: [0, 0, 0] } satisfies SegBox,
        voxels: 1,
        components: 1,
        truncated: false
      }
      pendingA[0].callback(pendingA[0].token, result)
      expect(a.getState().preview?.voxels).toBe(1)
      expect(b.getState().preview).toBeNull()

      a.dispose()
      pendingA[0].callback(pendingA[0].token, { ...result, voxels: 2 })
      expect(a.getState().preview?.voxels).toBe(1)
      pendingB[0].callback(pendingB[0].token, { ...result, voxels: 3 })
      expect(b.getState().preview?.voxels).toBe(3)
    } finally {
      a.dispose()
      b.dispose()
    }
  })
})

describe('render settings', () => {
  it('defaults to MIP with mid density', () => {
    const s = useStore.getState()
    expect(s.renderMode).toBe('mip')
    expect(s.density).toBeCloseTo(0.35)
  })

  it('clamps density to its bounds', () => {
    useStore.getState().setDensity(99)
    expect(useStore.getState().density).toBe(DENSITY_MAX)
    useStore.getState().setDensity(-1)
    expect(useStore.getState().density).toBe(DENSITY_MIN)
    useStore.getState().setDensity(0.5)
    expect(useStore.getState().density).toBe(0.5)
  })

  it('survives loading a new volume (viewing preference, not data)', () => {
    useStore.getState().setRenderMode('composite')
    useStore.getState().setDensity(0.7)
    useStore.getState().toggleDirectionLabels()
    useStore.getState().toggleCrosshair()
    const vol = fakeVolume({ dataMin: 0, dataMax: 100, p2: 5, p98: 95 })
    // Minimal fields setVolume touches beyond stats:
    ;(vol as { dims: number[] }).dims = [4, 4, 4]
    useStore.getState().setVolume(vol)
    expect(useStore.getState().renderMode).toBe('composite')
    expect(useStore.getState().density).toBe(0.7)
    expect(useStore.getState().directionLabelsVisible).toBe(false)
    expect(useStore.getState().crosshairVisible).toBe(false)
  })
})

describe('brightness', () => {
  it('defaults below 1 so projected maxima keep structure', () => {
    expect(BRIGHTNESS_DEFAULT).toBeLessThan(1)
    expect(useStore.getState().brightness).toBe(BRIGHTNESS_DEFAULT)
  })

  it('clamps to bounds', () => {
    useStore.getState().setBrightness(5)
    expect(useStore.getState().brightness).toBe(BRIGHTNESS_MAX)
    useStore.getState().setBrightness(0)
    expect(useStore.getState().brightness).toBe(BRIGHTNESS_MIN)
    useStore.getState().setBrightness(BRIGHTNESS_DEFAULT)
  })
})

describe('opened folder', () => {
  const folder = {
    root: '/data/set',
    files: [{ name: 'a.nii', path: '/data/set/a.nii', relDir: '' }],
    truncated: false
  }

  it('setFolder stores it, shows the panel, and closeFolder clears it', () => {
    useStore.getState().toggleFilePanel()
    expect(useStore.getState().filePanelOpen).toBe(false)
    useStore.getState().setFolder(folder)
    expect(useStore.getState().folder).toEqual(folder)
    expect(useStore.getState().filePanelOpen).toBe(true)
    useStore.getState().closeFolder()
    expect(useStore.getState().folder).toBeNull()
  })

  it('a filter typed during a streaming scan survives the final list', () => {
    useStore.getState().setFolder(folder)
    useStore.getState().setFileFilter('b2')
    // The scan's final result re-sets the same root: the filter must stay.
    useStore.getState().setFolder({ ...folder, truncated: true })
    expect(useStore.getState().fileFilter).toBe('b2')
    // A different folder resets it.
    useStore.getState().setFolder({ ...folder, root: '/other' })
    expect(useStore.getState().fileFilter).toBe('')
  })

  it('appendFolderFiles merges sorted, dedups, and ignores other roots', () => {
    useStore.getState().setFolder(folder)
    useStore.getState().appendFolderFiles('/data/set', [
      { name: 'b10.nii', path: '/data/set/g/b10.nii', relDir: 'g' },
      { name: 'b2.nii', path: '/data/set/g/b2.nii', relDir: 'g' },
      { name: 'a.nii', path: '/data/set/a.nii', relDir: '' }
    ])
    expect(useStore.getState().folder?.files.map((f) => f.name)).toEqual([
      'a.nii',
      'b2.nii',
      'b10.nii'
    ])
    const before = useStore.getState().folder
    useStore
      .getState()
      .appendFolderFiles('/other/root', [{ name: 'c.nii', path: '/other/root/c.nii', relDir: '' }])
    expect(useStore.getState().folder).toBe(before)
    useStore.getState().closeFolder()
  })

  it('survives loading a file that belongs to it', () => {
    useStore.getState().setFolder(folder)
    useStore.getState().setVolume(baseVolume(), '/data/set/a.nii')
    expect(useStore.getState().folder).toEqual(folder)
  })

  it('clears when a base volume from outside it loads', () => {
    useStore.getState().setFolder(folder)
    useStore.getState().setVolume(baseVolume(), '/elsewhere/b.nii')
    expect(useStore.getState().folder).toBeNull()
    useStore.getState().setFolder(folder)
    useStore.getState().setVolume(baseVolume())
    expect(useStore.getState().folder).toBeNull()
  })
})

describe('overlay layers', () => {
  function seedOverlays(): void {
    useStore.getState().setVolume(baseVolume())
    useStore.getState().addOverlay(fakeVolume({ dataMin: 0, dataMax: 1, typeRange: [0, 255] }, 2))
    useStore.getState().addOverlay(fakeVolume({ dataMin: -50, dataMax: 80 }, 16))
  }

  it('addOverlay appends with guessed kind, defaults, and unique ids', () => {
    seedOverlays()
    const [a, b] = useStore.getState().overlays
    expect(a.kind).toBe('mask')
    expect(b.kind).toBe('map')
    expect(b.colormap).toBe('signed')
    expect(b.range).toEqual({ lo: 0, hi: 80 })
    expect(a.id).not.toBe(b.id)
    expect(a.visible).toBe(true)
    expect(a.opacity).toBeCloseTo(0.6)
  })

  it('removeOverlay drops only the matching layer', () => {
    seedOverlays()
    const [a, b] = useStore.getState().overlays
    useStore.getState().removeOverlay(a.id)
    expect(useStore.getState().overlays.map((l) => l.id)).toEqual([b.id])
  })

  it('updateOverlay patches immutably', () => {
    seedOverlays()
    const before = useStore.getState().overlays
    const target = before[0]
    useStore.getState().updateOverlay(target.id, { kind: 'labels', opacity: 0.3 })
    const after = useStore.getState().overlays
    expect(after).not.toBe(before)
    expect(after[0]).not.toBe(target)
    expect(after[0].kind).toBe('labels')
    expect(after[0].opacity).toBeCloseTo(0.3)
    expect(after[0].volume).toBe(target.volume)
  })

  it('setVolume clears all layers', () => {
    seedOverlays()
    expect(useStore.getState().overlays.length).toBeGreaterThan(0)
    useStore.getState().setVolume(baseVolume())
    expect(useStore.getState().overlays).toEqual([])
  })
})

describe('regions', () => {
  /** 2x2x2 volume with two frames; frame 1 values sit 100 above frame 0. */
  function segVolume(): Volume {
    const n = 8
    const raw = new Float32Array(n * 2)
    for (let i = 0; i < n; i++) {
      raw[i] = i
      raw[n + i] = i + 100
    }
    const vol = fakeVolume({ dataMin: 0, dataMax: 107 })
    Object.assign(vol, { dims: [2, 2, 2], frames: 2, raw })
    return vol
  }

  /** Load segVolume and hand-plant one region (id 1) on voxels 0 and 1. */
  function seedRegion(target: AppStore = useStore): void {
    target.getState().setVolume(segVolume())
    const labelMap = new Uint16Array(8)
    labelMap[0] = 1
    labelMap[1] = 1
    target.setState({
      labelMap,
      regions: [
        {
          id: 1,
          name: 'Region 1',
          color: '#ff0000',
          visible: true,
          voxelCount: 2,
          stats: { min: 0, max: 1, mean: 0.5 }
        }
      ],
      nextRegionId: 2,
      segDirty: false
    })
  }

  it('makes stale buffer-mutating actions inert after dispose', () => {
    seedRegion()
    const stale = useStore.getState()
    const before = stale.labelMap!.slice()
    const revision = stale.labelMapRev
    const undo = stale.undoStack

    useStore.dispose()
    stale.deleteRegion(1)
    stale.setActiveRegion(1)
    stale.paintAt(0, [0, 0], [1, 1], true)
    stale.endStroke()
    stale.undo()

    expect(stale.labelMap).toEqual(before)
    expect(useStore.getState().labelMapRev).toBe(revision)
    expect(useStore.getState().undoStack).toBe(undo)
  })

  it('an in-flight brush gesture blocks only its own store history', () => {
    const other = createAppStore({ storage: null, pagehideTarget: null })
    try {
      seedRegion()
      seedRegion(other)
      other.getState().deleteRegion(1)
      expect(other.getState().regions).toEqual([])

      useStore.getState().setActiveRegion(1)
      useStore.getState().paintAt(0, [0, 0], [1, 1], false)
      other.getState().undo()
      expect(other.getState().regions).toHaveLength(1)
      expect(other.getState().labelMap![0]).toBe(1)

      useStore.getState().endStroke()
    } finally {
      other.dispose()
    }
  })

  it('metadata edits mark the segmentation unsaved', () => {
    seedRegion()
    useStore.getState().updateRegion(1, { name: 'renamed' })
    expect(useStore.getState().segDirty).toBe(true)

    useStore.setState({ segDirty: false })
    useStore.getState().updateRegion(1, { visible: false })
    expect(useStore.getState().segDirty).toBe(true)
  })

  it('metadata edits clear the redo stack (a redo would drop them)', () => {
    seedRegion()
    useStore.getState().deleteRegion(1)
    useStore.getState().undo()
    expect(useStore.getState().redoStack).toHaveLength(1)
    useStore.getState().updateRegion(1, { name: 'renamed' })
    expect(useStore.getState().redoStack).toEqual([])
    // Redo is now a no-op; the rename survives.
    useStore.getState().redo()
    expect(useStore.getState().regions[0].name).toBe('renamed')
  })

  it('metadata edits survive undo+redo of the region-creating entry', () => {
    seedRegion()
    // Simulate the commit's creation entry: undo removes region 1, redo
    // resurrects it from the entry's `after` snapshot.
    const labelMap = useStore.getState().labelMap!
    useStore.setState({
      undoStack: [
        {
          patch: {
            indices: new Uint32Array([0, 1]),
            before: new Uint16Array([0, 0]),
            after: new Uint16Array([1, 1])
          },
          regions: { before: [], after: useStore.getState().regions },
          nextId: { before: 1, after: 2 }
        }
      ]
    })
    useStore.getState().updateRegion(1, { name: 'renamed', color: '#00ff00' })
    useStore.getState().undo()
    expect(useStore.getState().regions).toEqual([])
    expect(labelMap[0]).toBe(0)
    useStore.getState().redo()
    // The resurrected region carries the post-commit edits, not the
    // metadata frozen into the snapshot at commit time.
    const region = useStore.getState().regions[0]
    expect(region.name).toBe('renamed')
    expect(region.color).toBe('#00ff00')
  })

  it('setFrame defers region stats until the latest target is refreshed', () => {
    seedRegion()
    useStore.getState().setFrame(1)
    expect(useStore.getState().regions[0].stats?.mean).toBe(0.5)
    useStore.getState().refreshRegionStats()
    const region = useStore.getState().regions[0]
    expect(region.stats).toEqual({ min: 100, max: 101, mean: 100.5 })
    // Stats refresh alone is not an edit.
    expect(useStore.getState().segDirty).toBe(false)
  })

  it('reuses bounded per-frame stats while the label revision is unchanged', () => {
    seedRegion()
    useStore.getState().refreshRegionStats()
    const raw = useStore.getState().volume!.raw as Float32Array
    // Volume samples are immutable in production; changing them here makes a
    // cache hit distinguishable from another full scan.
    raw[0] = 50
    raw[1] = 60

    useStore.getState().setFrame(1)
    useStore.getState().refreshRegionStats()
    expect(useStore.getState().regions[0].stats?.mean).toBe(100.5)
    useStore.getState().setFrame(0)
    useStore.getState().refreshRegionStats()
    expect(useStore.getState().regions[0].stats?.mean).toBe(0.5)
  })

  it('collapses repeated frame targets into one debounced refresh', () => {
    vi.useFakeTimers()
    seedRegion()
    const before = useStore.getState().regions
    useStore.getState().setFrame(1)
    useStore.getState().setFrame(0)
    useStore.getState().setFrame(1)
    expect(useStore.getState().regions).toBe(before)
    expect(useStore.getState().regions[0].stats?.mean).toBe(0.5)
    vi.advanceTimersByTime(REGION_STATS_DEBOUNCE_MS - 1)
    expect(useStore.getState().regions[0].stats?.mean).toBe(0.5)
    vi.advanceTimersByTime(1)
    expect(useStore.getState().regions[0].stats?.mean).toBe(100.5)
  })

  it('cancels a pending frame-stat refresh when stroke completion already refreshes it', () => {
    vi.useFakeTimers()
    seedRegion()
    useStore.getState().setFrame(1)
    expect(vi.getTimerCount()).toBe(1)
    useStore.getState().setActiveRegion(1)
    useStore.getState().paintAt(0, [0, 0], [0, 0], false)
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(REGION_STATS_DEBOUNCE_MS)
    // The long gesture did not refresh midway; pointer-up owns the scan.
    expect(useStore.getState().regions[0].stats?.mean).toBe(0.5)
    useStore.getState().endStroke()
    expect(vi.getTimerCount()).toBe(0)
    expect(useStore.getState().regions[0].stats?.mean).toBeGreaterThan(100)
  })

  it('defers a frame-stat refresh scheduled after a brush stroke began', () => {
    vi.useFakeTimers()
    seedRegion()
    useStore.getState().setActiveRegion(1)
    useStore.getState().paintAt(0, [0, 0], [0, 0], false)
    useStore.getState().setFrame(1)

    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(REGION_STATS_DEBOUNCE_MS)
    expect(useStore.getState().regions[0].stats?.mean).toBe(0.5)

    useStore.getState().endStroke()
    expect(useStore.getState().regions[0].stats?.mean).toBeGreaterThan(100)
  })

  it('refreshes the deferred frame after a no-op stroke ends', () => {
    vi.useFakeTimers()
    seedRegion()
    const before = useStore.getState()
    before.setActiveRegion(1)
    // The crosshair is on slice 1 while region 1 occupies slice 0, so this
    // erase opens a gesture collector without changing a voxel.
    before.paintAt(0, [0, 0], [0, 0], true)
    before.setFrame(1)

    expect(vi.getTimerCount()).toBe(0)
    before.endStroke()
    expect(useStore.getState().regions[0].stats?.mean).toBe(100.5)
    expect(useStore.getState().segDirty).toBe(before.segDirty)
    expect(useStore.getState().segRevision).toBe(before.segRevision)
  })

  it('cancels a pending frame-stat refresh when commit already refreshes it', () => {
    vi.useFakeTimers()
    seedRegion()
    useStore.getState().setFrame(1)
    const params = useStore.getState().segParams
    useStore.setState({ segParams: { ...params, low: 103, high: 103, minVoxels: 1 } })
    useStore.getState().setSegBox({ min: [0, 0, 0], max: [1, 1, 1] })
    expect(vi.getTimerCount()).toBe(2)
    useStore.getState().commitPreview()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels a pending frame-stat refresh when history already refreshes it', () => {
    vi.useFakeTimers()
    seedRegion()
    useStore.getState().setActiveRegion(1)
    useStore.getState().paintAt(0, [0, 0], [0, 0], false)
    useStore.getState().endStroke()
    useStore.getState().setFrame(1)
    expect(vi.getTimerCount()).toBe(1)
    useStore.getState().undo()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps no-op brush erases clean and revision-stable', () => {
    vi.useFakeTimers()
    seedRegion()
    const exported = useStore.getState()
    exported.markExported(exported.volume!, exported.sourcePath, exported.segRevision)
    useStore.setState({
      segBox: { min: [0, 0, 0], max: [1, 1, 1] },
      segParams: {
        ...useStore.getState().segParams,
        constraint: { type: 'region', regionId: 1 }
      }
    })
    const before = useStore.getState()
    const timerCount = vi.getTimerCount()
    before.setActiveRegion(1)
    // The default crosshair is on slice 1; region 1 occupies only slice 0.
    before.paintAt(0, [0, 0], [0, 0], true)
    before.endStroke()

    const after = useStore.getState()
    expect(after.segDirty).toBe(false)
    expect(after.segRevision).toBe(before.segRevision)
    expect(after.labelMapRev).toBe(before.labelMapRev)
    expect(after.undoStack).toBe(before.undoStack)
    expect(after.regions).toBe(before.regions)
    expect(vi.getTimerCount()).toBe(timerCount)
  })

  it('deleteRegion clears a constraint pointing at the deleted region', () => {
    seedRegion()
    const params = useStore.getState().segParams
    useStore.setState({ segParams: { ...params, constraint: { type: 'region', regionId: 1 } } })
    useStore.getState().deleteRegion(1)
    expect(useStore.getState().segParams.constraint).toEqual({ type: 'none' })
    expect(useStore.getState().regions).toEqual([])
  })

  it('deleting the last region still counts as unsaved', () => {
    seedRegion()
    const s = useStore.getState()
    s.markExported(s.volume!, s.sourcePath, s.segRevision)
    expect(hasUnsavedRegions(useStore)).toBe(false)
    useStore.getState().deleteRegion(1)
    expect(useStore.getState().regions).toEqual([])
    expect(hasUnsavedRegions(useStore)).toBe(true)
  })

  it('markExported records the source path for the file panel', () => {
    seedRegion()
    useStore.setState({ sourcePath: '/data/a.nii.gz', segDirty: true })
    const s = useStore.getState()
    s.markExported(s.volume!, s.sourcePath, s.segRevision)
    expect(useStore.getState().exportedPaths.has('/data/a.nii.gz')).toBe(true)
    expect(useStore.getState().segDirty).toBe(false)

    // A pathless source (e.g. a bundled sample) records nothing.
    const before = useStore.getState().exportedPaths
    useStore.setState({ sourcePath: null, segDirty: true })
    useStore
      .getState()
      .markExported(useStore.getState().volume!, null, useStore.getState().segRevision)
    expect(useStore.getState().exportedPaths).toBe(before)
    expect(useStore.getState().segDirty).toBe(false)
  })

  it('a newer edit drops a pending delete-undo toast (its button would hit the wrong entry)', () => {
    seedRegion()
    useStore.getState().labelMap![2] = 2
    useStore.setState((prev) => ({
      regions: [
        ...prev.regions,
        {
          id: 2,
          name: 'Region 2',
          color: '#00ff00',
          visible: true,
          voxelCount: 1,
          stats: { min: 2, max: 2, mean: 2 }
        }
      ],
      nextRegionId: 3
    }))
    useStore
      .getState()
      .pushToast({ text: 'exported', action: { label: 'Show', kind: 'reveal', path: '/x' } })

    useStore.getState().deleteRegion(1)
    expect(useStore.getState().toasts.some((t) => t.action?.kind === 'undo')).toBe(true)

    // A second delete pushes a new history entry: the first toast's Undo
    // would now revert THIS delete, so only the newest undo toast survives.
    useStore.getState().deleteRegion(2)
    const toasts = useStore.getState().toasts
    const undoToasts = toasts.filter((t) => t.action?.kind === 'undo')
    expect(undoToasts).toHaveLength(1)
    expect(undoToasts[0].text).toContain('Region 2')
    // Toasts without an undo action are untouched.
    expect(toasts.some((t) => t.action?.kind === 'reveal')).toBe(true)
  })

  it('undo of a delete keeps metadata edits made to other regions afterwards', () => {
    seedRegion()
    useStore.getState().labelMap![2] = 2
    useStore.setState((prev) => ({
      regions: [
        ...prev.regions,
        {
          id: 2,
          name: 'Region 2',
          color: '#00ff00',
          visible: true,
          voxelCount: 1,
          stats: { min: 2, max: 2, mean: 2 }
        }
      ],
      nextRegionId: 3
    }))
    useStore.getState().deleteRegion(1)
    // Rename/recolor after the delete: metadata edits push no history entry,
    // so the undo's snapshot restore must not revert them.
    useStore.getState().updateRegion(2, { name: 'renamed', color: '#123456' })
    useStore.getState().undo()
    const regions = useStore.getState().regions
    expect(regions.map((r) => r.id).sort()).toEqual([1, 2])
    const r2 = regions.find((r) => r.id === 2)!
    expect(r2.name).toBe('renamed')
    expect(r2.color).toBe('#123456')
    // The deleted region itself is fully restored, voxels included.
    expect(regions.find((r) => r.id === 1)?.name).toBe('Region 1')
    expect(useStore.getState().labelMap![0]).toBe(1)
  })

  it('an export finishing after a volume swap marks its own source, not the new one', () => {
    seedRegion()
    useStore.setState({ sourcePath: '/data/a.nii.gz' })
    const exportedVolume = useStore.getState().volume!
    const exportedPath = useStore.getState().sourcePath

    // The user navigates to another file and edits it while the export of
    // the previous file is still writing.
    seedRegion()
    useStore.setState({ sourcePath: '/data/b.nii.gz', segDirty: true })

    useStore.getState().markExported(exportedVolume, exportedPath, 0)
    const after = useStore.getState()
    expect(after.exportedPaths.has('/data/a.nii.gz')).toBe(true) // the real export
    expect(after.exportedPaths.has('/data/b.nii.gz')).toBe(false) // never exported
    expect(after.segDirty).toBe(true) // the new volume's edits stay unsaved
  })

  it('an older export cannot mark newer edits on the same volume as saved', () => {
    seedRegion()
    const started = useStore.getState()
    const exportedVolume = started.volume!
    const exportedRevision = started.segRevision

    started.updateRegion(1, { name: 'newer edit' })
    expect(useStore.getState().segRevision).toBeGreaterThan(exportedRevision)
    useStore.getState().markExported(exportedVolume, '/data/a.nii.gz', exportedRevision)

    const after = useStore.getState()
    expect(after.segDirty).toBe(true)
    expect(after.exportedPaths.has('/data/a.nii.gz')).toBe(true)
  })

  it('floodCap caps only floods whose bounds cover the whole volume', () => {
    const p = (over: Partial<SegParams>): SegParams => ({
      method: 'threshold',
      low: 55,
      high: 55,
      connectivity: 26,
      minVoxels: 3,
      growMargin: null,
      constraint: { type: 'none' },
      ...over
    })
    const VOL = 1000
    // Threshold: never capped, even when the box spans the whole volume.
    expect(floodCap(p({}), 100, VOL)).toBe(Infinity)
    expect(floodCap(p({}), VOL, VOL)).toBe(Infinity)
    // Grow with genuinely partial bounds (margin-dilated box): uncapped.
    expect(floodCap(p({ method: 'grow', growMargin: 20 }), 400, VOL)).toBe(Infinity)
    // Grow whose bounds reach the whole volume — unlimited reach,
    // constraint-bounded, or a margin so large it clamps to the volume.
    expect(floodCap(p({ method: 'grow' }), VOL, VOL)).toBe(MAX_RESULT_VOXELS)
    expect(floodCap(p({ method: 'grow', growMargin: 99999 }), VOL, VOL)).toBe(MAX_RESULT_VOXELS)
  })

  it('setSegParams keeps voxel-count fields whole', () => {
    useStore.getState().setVolume(segVolume())
    useStore.getState().setSegParams({ growMargin: 2.5, minVoxels: 0.4 })
    expect(useStore.getState().segParams.growMargin).toBe(3)
    expect(useStore.getState().segParams.minVoxels).toBe(1)
    useStore.getState().setSegParams({ growMargin: null })
    expect(useStore.getState().segParams.growMargin).toBeNull()
  })

  it('grow thresholds never cross: the edited side drags the other', () => {
    useStore.getState().setVolume(segVolume())
    const base = useStore.getState().segParams
    useStore.setState({ segParams: { ...base, method: 'grow', low: 60, high: 300 } })
    // Lowering the seed below the boundary pulls the boundary down with it.
    useStore.getState().setSegParams({ high: 45 })
    expect(useStore.getState().segParams).toMatchObject({ low: 45, high: 45 })
    // Raising the boundary above the seed pushes the seed up.
    useStore.getState().setSegParams({ low: 70 })
    expect(useStore.getState().segParams).toMatchObject({ low: 70, high: 70 })
  })

  it('commit within the preview debounce window applies the fresh mask', () => {
    useStore.getState().setVolume(segVolume())
    const params = useStore.getState().segParams
    useStore.setState({
      segParams: { ...params, method: 'threshold', low: 3, high: 3, minVoxels: 1 }
    })
    // setSegBox only schedules the (90 ms debounced) preview...
    useStore.getState().setSegBox({ min: [0, 0, 0], max: [1, 1, 1] })
    expect(useStore.getState().preview).toBeNull()
    // ...but an immediate commit must not act on the stale (null) preview.
    useStore.getState().commitPreview()
    const s = useStore.getState()
    expect(s.regions.length).toBe(1)
    expect(s.regions[0].voxelCount).toBe(5) // values 3..7 of 0..7
    expect(s.segDirty).toBe(true)
  })

  it('undo is a no-op while a brush stroke is in flight', () => {
    seedRegion()
    useStore.getState().setActiveRegion(1)
    useStore.getState().setBrushRadius(1)
    // A complete gesture -> one history entry (cross sits on slice 1).
    useStore.getState().paintAt(0, [0, 0], [1, 1], false)
    useStore.getState().endStroke()
    expect(useStore.getState().undoStack).toHaveLength(1)
    // Second gesture in flight: history must not move under the collector
    // (menu accelerators can fire mid-drag).
    useStore.getState().paintAt(0, [0, 0], [1, 1], true)
    useStore.getState().undo()
    expect(useStore.getState().undoStack).toHaveLength(1)
    expect(useStore.getState().redoStack).toHaveLength(0)
    useStore.getState().endStroke()
    expect(useStore.getState().undoStack).toHaveLength(2)
  })

  it('commit and delete are blocked while a brush stroke is in flight', () => {
    seedRegion()
    useStore.getState().setActiveRegion(1)
    useStore.getState().setBrushRadius(1)
    useStore.setState({ segParams: { ...useStore.getState().segParams, low: 3, high: 3 } })
    useStore.getState().setSegBox({ min: [0, 0, 0], max: [1, 1, 1] })
    useStore.getState().paintAt(0, [0, 0], [1, 1], false)
    // Enter mid-drag: the commit must not write under the open collector.
    useStore.getState().commitPreview()
    expect(useStore.getState().regions).toHaveLength(1)
    expect(useStore.getState().segBox).not.toBeNull()
    // A delete from a second pointer is blocked the same way.
    useStore.getState().deleteRegion(1)
    expect(useStore.getState().regions).toHaveLength(1)
    useStore.getState().endStroke()
    useStore.getState().commitPreview()
    expect(useStore.getState().regions).toHaveLength(2)
  })

  it('a stroke whose regions vanished mid-gesture is reverted, not orphaned', () => {
    seedRegion()
    useStore.getState().setActiveRegion(1)
    useStore.getState().setBrushRadius(1)
    const labelMap = useStore.getState().labelMap!
    useStore.getState().paintAt(0, [0, 0], [1, 1], false)
    expect(labelMap.slice(4).some((v) => v === 1)).toBe(true) // stamped slice 1
    // All regions removed mid-gesture by another input path.
    useStore.setState({ regions: [], activeRegionId: null })
    useStore.getState().endStroke()
    // The stamps are reverted (they would otherwise silently join the next
    // region to reuse id 1); the untouched seed voxels stay.
    expect(labelMap.slice(4).every((v) => v === 0)).toBe(true)
    expect(labelMap[0]).toBe(1)
    expect(useStore.getState().undoStack).toHaveLength(0)
  })

  it('undo of a re-segment restores the snapshot the next re-edit opens with', () => {
    useStore.getState().setVolume(segVolume())
    const params = useStore.getState().segParams
    useStore.setState({
      segParams: { ...params, method: 'threshold', low: 3, high: 3, minVoxels: 1 }
    })
    useStore.getState().setSegBox({ min: [0, 0, 0], max: [1, 1, 1] })
    useStore.getState().commitPreview()
    expect(useStore.getState().segSnapshots[1].params.low).toBe(3)

    // Re-segment region 1 from a different box with a different threshold.
    useStore.getState().editRegion(1)
    useStore.getState().setSegBox({ min: [0, 0, 1], max: [1, 1, 1] })
    useStore.getState().setSegParams({ low: 5, high: 5 })
    useStore.getState().commitPreview()
    expect(useStore.getState().segSnapshots[1].params.low).toBe(5)

    // Undo the re-segment: a re-edit must open with the ORIGINAL box/params,
    // not the undone ones.
    useStore.getState().undo()
    expect(useStore.getState().segSnapshots[1].params.low).toBe(3)
    expect(useStore.getState().segSnapshots[1].box).toEqual({ min: [0, 0, 0], max: [1, 1, 1] })

    // Redo brings the re-segment's snapshot back with its voxels.
    useStore.getState().redo()
    expect(useStore.getState().segSnapshots[1].params.low).toBe(5)

    // Undoing all the way past the region's creation removes its snapshot.
    useStore.getState().undo()
    useStore.getState().undo()
    expect(useStore.getState().regions).toEqual([])
    expect(useStore.getState().segSnapshots[1]).toBeUndefined()
  })
})
