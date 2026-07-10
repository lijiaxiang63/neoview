import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadViewPref } from '../src/renderer/src/files/viewPrefs'
import { createAppStore, type AppStore } from '../src/renderer/src/store'
import type { Volume, VolumeStats } from '../src/renderer/src/volume/types'

const mem = new Map<string, string>()
const storage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v)
}
let useStore: AppStore

function baseVolume(): Volume {
  const stats: VolumeStats = {
    dataMin: 0,
    dataMax: 100,
    p2: 5,
    p98: 95,
    typeRange: null
  }
  return {
    datatypeCode: 4,
    suggestedRange: null,
    slope: 1,
    inter: 0,
    dims: [4, 4, 4],
    stats
  } as Volume
}

describe('per-file display pref save', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useStore = createAppStore({ storage, pagehideTarget: null })
  })

  afterEach(() => {
    useStore.dispose()
    vi.useRealTimers()
    mem.clear()
  })

  it('two stores keep pending saves under their own paths', () => {
    const other = createAppStore({ storage, pagehideTarget: null })
    try {
      useStore.getState().setVolume(baseVolume(), '/data/a')
      other.getState().setVolume(baseVolume(), '/data/b')
      useStore.getState().setRange(5, 50)
      other.getState().setRange(10, 60)
      useStore.dispose()
      expect(loadViewPref('/data/a', storage)).toEqual({ preset: 'custom', lo: 5, hi: 50 })
      expect(loadViewPref('/data/b', storage)).toBeNull()
      expect(vi.getTimerCount()).toBe(1)
      vi.advanceTimersByTime(400)
      expect(loadViewPref('/data/b', storage)).toEqual({ preset: 'custom', lo: 10, hi: 60 })
    } finally {
      other.dispose()
    }
  })

  it('a range change is saved under the file it was made on, even after navigating away', () => {
    useStore.getState().setVolume(baseVolume(), '/data/a.nii')
    useStore.getState().setRange(5, 50)
    // Navigate to another file before the debounce fires: the save must
    // still be attributed to the edited file, not the current one.
    useStore.getState().setVolume(baseVolume(), '/data/b.nii')
    vi.advanceTimersByTime(400)
    expect(loadViewPref('/data/a.nii', storage)).toEqual({ preset: 'custom', lo: 5, hi: 50 })
    expect(loadViewPref('/data/b.nii', storage)).toBeNull()
  })

  it("editing a second file within the debounce window keeps the first file's save", () => {
    useStore.getState().setVolume(baseVolume(), '/data/a.nii')
    useStore.getState().setRange(5, 50)
    useStore.getState().setVolume(baseVolume(), '/data/b.nii')
    // B's edit lands inside A's debounce window; it must not cancel A's save.
    useStore.getState().setRange(10, 60)
    vi.advanceTimersByTime(400)
    expect(loadViewPref('/data/a.nii', storage)).toEqual({ preset: 'custom', lo: 5, hi: 50 })
    expect(loadViewPref('/data/b.nii', storage)).toEqual({ preset: 'custom', lo: 10, hi: 60 })
  })

  it('reopening the same file within the debounce window restores the just-edited range', () => {
    useStore.getState().setVolume(baseVolume(), '/data/a.nii')
    useStore.getState().setRange(5, 50)
    // The pending save must be flushed before the reopened file's pref is
    // read back, or the edit would be silently lost.
    useStore.getState().setVolume(baseVolume(), '/data/a.nii')
    expect(useStore.getState().range).toEqual({ lo: 5, hi: 50 })
    expect(useStore.getState().activePreset).toBe('custom')
  })
})
