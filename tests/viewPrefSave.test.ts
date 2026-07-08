import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadViewPref } from '../src/renderer/src/files/viewPrefs'
import type { Volume, VolumeStats } from '../src/renderer/src/volume/types'

// The store captures its pref storage at module load (absent in the test
// environment), so localStorage must be stubbed BEFORE the store is imported
// for the debounced pref save to be live in this file.
const mem = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v)
})
const { useStore } = await import('../src/renderer/src/store')

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
  afterEach(() => {
    vi.useRealTimers()
    mem.clear()
  })

  it('a range change is saved under the file it was made on, even after navigating away', () => {
    vi.useFakeTimers()
    useStore.getState().setVolume(baseVolume(), '/data/a.nii')
    useStore.getState().setRange(5, 50)
    // Navigate to another file before the debounce fires: the save must
    // still be attributed to the edited file, not the current one.
    useStore.getState().setVolume(baseVolume(), '/data/b.nii')
    vi.advanceTimersByTime(400)
    const storage = { getItem: (k: string) => mem.get(k) ?? null }
    expect(loadViewPref('/data/a.nii', storage)).toEqual({ preset: 'custom', lo: 5, hi: 50 })
    expect(loadViewPref('/data/b.nii', storage)).toBeNull()
  })
})
