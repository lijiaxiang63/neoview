import { describe, expect, it } from 'vitest'
import {
  BRIGHTNESS_DEFAULT,
  BRIGHTNESS_MAX,
  BRIGHTNESS_MIN,
  DENSITY_MAX,
  DENSITY_MIN,
  pickInitialPreset,
  presetRange,
  useStore
} from '../src/renderer/src/store'
import type { Volume, VolumeStats } from '../src/renderer/src/volume/types'

function fakeVolume(stats: Partial<VolumeStats>, datatypeCode = 4): Volume {
  return {
    datatypeCode,
    suggestedRange: null,
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
