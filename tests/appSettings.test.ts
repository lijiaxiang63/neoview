import { describe, expect, it, vi } from 'vitest'
import {
  defaultAppSettings,
  parseAppSettings,
  patchAppSettings,
  PLAYBACK_FPS_MAX,
  PLAYBACK_FPS_MIN,
  type AppSettings
} from '../src/shared/settings'
import { createAppSettingsStore } from '../src/main/appSettings'

describe('parseAppSettings', () => {
  it('round-trips a valid snapshot', () => {
    const settings: AppSettings = {
      playbackFps: 12,
      seg: { connectivity: 6, slabDepth: 5, brushRadius: 9 },
      expandLabelLists: false
    }
    expect(parseAppSettings(JSON.parse(JSON.stringify(settings)))).toEqual(settings)
  })

  it('returns defaults for unreadable roots', () => {
    for (const raw of [null, undefined, 'text', 7, true, []]) {
      expect(parseAppSettings(raw)).toEqual(defaultAppSettings())
    }
  })

  it('falls back field by field so one bad value keeps its siblings', () => {
    const parsed = parseAppSettings({
      playbackFps: 'fast',
      seg: { connectivity: 7, slabDepth: 4, brushRadius: Number.NaN },
      expandLabelLists: 1
    })
    const defaults = defaultAppSettings()
    expect(parsed).toEqual({
      playbackFps: defaults.playbackFps,
      seg: {
        connectivity: defaults.seg.connectivity,
        slabDepth: 4,
        brushRadius: defaults.seg.brushRadius
      },
      expandLabelLists: defaults.expandLabelLists
    })
  })

  it('clamps and rounds numeric fields', () => {
    const parsed = parseAppSettings({
      playbackFps: 99,
      seg: { connectivity: 26, slabDepth: 0.2, brushRadius: 0 },
      expandLabelLists: true
    })
    expect(parsed.playbackFps).toBe(PLAYBACK_FPS_MAX)
    expect(parsed.seg.slabDepth).toBe(1)
    expect(parsed.seg.brushRadius).toBe(1)
    expect(parseAppSettings({ playbackFps: 0 }).playbackFps).toBe(PLAYBACK_FPS_MIN)
    expect(parseAppSettings({ playbackFps: 7.6 }).playbackFps).toBe(8)
  })
})

describe('patchAppSettings', () => {
  const base = defaultAppSettings()

  it('applies only present, valid fields', () => {
    const next = patchAppSettings(base, { playbackFps: 20, seg: { connectivity: 6 } })
    expect(next).toEqual({
      playbackFps: 20,
      seg: { ...base.seg, connectivity: 6 },
      expandLabelLists: base.expandLabelLists
    })
  })

  it('rejects malformed shapes without touching current values', () => {
    for (const patch of [null, undefined, 'x', 4, []]) {
      expect(patchAppSettings(base, patch)).toEqual(base)
    }
    const next = patchAppSettings(base, {
      playbackFps: 'x',
      seg: { connectivity: 'many', slabDepth: null, brushRadius: undefined },
      expandLabelLists: 'yes'
    })
    expect(next).toEqual(base)
  })

  it('treats a non-object seg and non-finite numbers as absent', () => {
    for (const seg of ['x', 5, [], null, true]) {
      expect(patchAppSettings(base, { seg })).toEqual(base)
    }
    expect(patchAppSettings(base, { playbackFps: Number.NaN })).toEqual(base)
    expect(patchAppSettings(base, { seg: { slabDepth: Number.POSITIVE_INFINITY } })).toEqual(base)
  })

  it('clamps patched numbers against the shared bounds', () => {
    const next = patchAppSettings(base, { playbackFps: -3, seg: { brushRadius: 500 } })
    expect(next.playbackFps).toBe(PLAYBACK_FPS_MIN)
    expect(next.seg.brushRadius).toBe(30)
  })
})

describe('createAppSettingsStore', () => {
  it('parses the loaded value once and serves it', () => {
    const store = createAppSettingsStore({
      load: () => ({ playbackFps: 15 }),
      save: vi.fn(async () => {})
    })
    expect(store.snapshot().playbackFps).toBe(15)
  })

  it('persists a changed patch and skips no-op patches', async () => {
    const save = vi.fn(async () => {})
    const store = createAppSettingsStore({ load: () => null, save })

    const unchanged = store.patch({ playbackFps: defaultAppSettings().playbackFps })
    expect(unchanged).toEqual(defaultAppSettings())
    await store.settled()
    expect(save).not.toHaveBeenCalled()

    const changed = store.patch({ expandLabelLists: false })
    expect(changed.expandLabelLists).toBe(false)
    expect(store.snapshot().expandLabelLists).toBe(false)
    await store.settled()
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith(changed)
  })

  it('serializes writes and keeps saving after one failure', async () => {
    const order: number[] = []
    let calls = 0
    const store = createAppSettingsStore({
      load: () => null,
      save: async (settings) => {
        calls += 1
        const call = calls
        if (call === 1) {
          await Promise.resolve()
          order.push(settings.playbackFps)
          throw new Error('disk full')
        }
        order.push(settings.playbackFps)
      }
    })

    store.patch({ playbackFps: 10 })
    store.patch({ playbackFps: 11 })
    await store.settled()
    expect(order).toEqual([10, 11])
    expect(store.snapshot().playbackFps).toBe(11)
  })
})
