import { create } from 'zustand'
import type { Volume } from './volume/types'

export type Preset = 'auto' | 'full' | 'fixed-0-80' | 'suggested' | 'custom'

export type RenderMode = 'mip' | 'composite'

export interface HoverInfo {
  view: 0 | 1 | 2
  ijk: [number, number, number]
}

interface AppState {
  volume: Volume | null
  loadState: 'empty' | 'loading' | 'ready' | 'error'
  errorMessage: string | null
  cross: [number, number, number]
  frame: number
  range: { lo: number; hi: number }
  activePreset: Preset
  hover: HoverInfo | null
  renderMode: RenderMode
  density: number
  brightness: number

  startLoading: () => void
  setVolume: (v: Volume) => void
  fail: (message: string) => void
  dismissError: () => void
  setCross: (ijk: [number, number, number]) => void
  setFrame: (t: number) => void
  setRange: (lo: number, hi: number) => void
  applyPreset: (p: Exclude<Preset, 'custom'>) => void
  setHover: (h: HoverInfo | null) => void
  setRenderMode: (m: RenderMode) => void
  setDensity: (d: number) => void
  setBrightness: (b: number) => void
}

export const DENSITY_MIN = 0.02
export const DENSITY_MAX = 1
export const BRIGHTNESS_MIN = 0.05
export const BRIGHTNESS_MAX = 1
export const BRIGHTNESS_DEFAULT = 0.45

export function presetRange(vol: Volume, p: Exclude<Preset, 'custom'>): { lo: number; hi: number } {
  const { stats } = vol
  switch (p) {
    case 'auto':
      return { lo: stats.p2, hi: stats.p98 }
    case 'full':
      return stats.typeRange
        ? { lo: stats.typeRange[0], hi: stats.typeRange[1] }
        : { lo: stats.dataMin, hi: stats.dataMax }
    case 'fixed-0-80':
      return { lo: 0, hi: 80 }
    case 'suggested':
      return vol.suggestedRange ?? { lo: stats.dataMin, hi: stats.dataMax }
  }
}

export function pickInitialPreset(vol: Volume): Exclude<Preset, 'custom'> {
  const { stats } = vol
  if (stats.p2 === stats.p98) return 'full'
  // A deep negative floor paired with a wide positive extent means the data is
  // calibrated so that the fixed 0–80 window isolates the low-contrast mid-tones
  // a full-range map would flatten. The large negative plateau is exactly what a
  // full range would waste most of its span on, so default to the fixed window.
  if (stats.p2 <= -300 && stats.dataMin >= -3000 && stats.dataMax >= 200) {
    return 'fixed-0-80'
  }
  if (vol.datatypeCode === 2 && stats.dataMax <= 255 && stats.dataMax - stats.dataMin >= 128) {
    return 'full'
  }
  return 'auto'
}

export const useStore = create<AppState>()((set, get) => ({
  volume: null,
  loadState: 'empty',
  errorMessage: null,
  cross: [0, 0, 0],
  frame: 0,
  range: { lo: 0, hi: 1 },
  activePreset: 'auto',
  hover: null,
  renderMode: 'mip',
  density: 0.35,
  brightness: BRIGHTNESS_DEFAULT,

  startLoading: () => set({ loadState: 'loading', errorMessage: null }),

  setVolume: (v) => {
    const preset = pickInitialPreset(v)
    set({
      volume: v,
      loadState: 'ready',
      errorMessage: null,
      cross: [Math.floor(v.dims[0] / 2), Math.floor(v.dims[1] / 2), Math.floor(v.dims[2] / 2)],
      frame: 0,
      range: presetRange(v, preset),
      activePreset: preset,
      hover: null
    })
  },

  fail: (message) =>
    set((s) => ({
      errorMessage: message,
      loadState: s.volume ? 'ready' : 'error'
    })),

  dismissError: () => set((s) => ({ errorMessage: null, loadState: s.volume ? 'ready' : 'empty' })),

  setCross: (ijk) => {
    const vol = get().volume
    if (!vol) return
    set({
      cross: [
        Math.min(Math.max(ijk[0], 0), vol.dims[0] - 1),
        Math.min(Math.max(ijk[1], 0), vol.dims[1] - 1),
        Math.min(Math.max(ijk[2], 0), vol.dims[2] - 1)
      ]
    })
  },

  setFrame: (t) => {
    const vol = get().volume
    if (!vol) return
    set({ frame: Math.min(Math.max(t, 0), vol.frames - 1) })
  },

  setRange: (lo, hi) => set({ range: { lo, hi }, activePreset: 'custom' }),

  applyPreset: (p) => {
    const vol = get().volume
    if (!vol) return
    set({ range: presetRange(vol, p), activePreset: p })
  },

  setHover: (h) => set({ hover: h }),

  setRenderMode: (m) => set({ renderMode: m }),

  setDensity: (d) => set({ density: Math.min(DENSITY_MAX, Math.max(DENSITY_MIN, d)) }),

  setBrightness: (b) => set({ brightness: Math.min(BRIGHTNESS_MAX, Math.max(BRIGHTNESS_MIN, b)) })
}))
