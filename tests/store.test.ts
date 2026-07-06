import { describe, expect, it } from 'vitest'
import {
  BRIGHTNESS_DEFAULT,
  BRIGHTNESS_MAX,
  BRIGHTNESS_MIN,
  DENSITY_MAX,
  DENSITY_MIN,
  floodCap,
  hasUnsavedRegions,
  pickInitialPreset,
  presetRange,
  useStore,
  type SegParams
} from '../src/renderer/src/store'
import { MAX_RESULT_VOXELS } from '../src/renderer/src/segmentation/segment'
import type { Volume, VolumeStats } from '../src/renderer/src/volume/types'

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
    const vol = fakeVolume({ dataMin: 0, dataMax: 100, p2: 5, p98: 95 })
    // Minimal fields setVolume touches beyond stats:
    ;(vol as { dims: number[] }).dims = [4, 4, 4]
    useStore.getState().setVolume(vol)
    expect(useStore.getState().renderMode).toBe('composite')
    expect(useStore.getState().density).toBe(0.7)
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

describe('overlay layers', () => {
  it('addOverlay appends with guessed kind, defaults, and unique ids', () => {
    useStore.getState().setVolume(baseVolume())
    const mask = fakeVolume({ dataMin: 0, dataMax: 1, typeRange: [0, 255] }, 2)
    const map = fakeVolume({ dataMin: -50, dataMax: 80 }, 16)
    useStore.getState().addOverlay(mask)
    useStore.getState().addOverlay(map)
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
    const [a, b] = useStore.getState().overlays
    useStore.getState().removeOverlay(a.id)
    expect(useStore.getState().overlays.map((l) => l.id)).toEqual([b.id])
  })

  it('updateOverlay patches immutably', () => {
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
  function seedRegion(): void {
    useStore.getState().setVolume(segVolume())
    const labelMap = new Uint16Array(8)
    labelMap[0] = 1
    labelMap[1] = 1
    useStore.setState({
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

  it('metadata edits mark the segmentation unsaved', () => {
    seedRegion()
    useStore.getState().updateRegion(1, { name: 'renamed' })
    expect(useStore.getState().segDirty).toBe(true)

    useStore.setState({ segDirty: false })
    useStore.getState().updateRegion(1, { visible: false })
    expect(useStore.getState().segDirty).toBe(true)
  })

  it('setFrame recomputes region stats for the new frame', () => {
    seedRegion()
    useStore.getState().setFrame(1)
    const region = useStore.getState().regions[0]
    expect(region.stats).toEqual({ min: 100, max: 101, mean: 100.5 })
    // Stats refresh alone is not an edit.
    expect(useStore.getState().segDirty).toBe(false)
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
    useStore.getState().markExported()
    expect(hasUnsavedRegions()).toBe(false)
    useStore.getState().deleteRegion(1)
    expect(useStore.getState().regions).toEqual([])
    expect(hasUnsavedRegions()).toBe(true)
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
})
