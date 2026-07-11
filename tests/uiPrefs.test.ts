import { describe, expect, it, vi } from 'vitest'
import {
  defaultUiPrefs,
  loadUiPrefs,
  saveUiPrefs,
  UI_PREFS_KEY,
  type UiPrefs
} from '../src/renderer/src/files/uiPrefs'
import {
  SIDE_PANEL_WIDTH_DEFAULT,
  SIDE_PANEL_WIDTH_MAX,
  SIDE_PANEL_WIDTH_MIN
} from '../src/renderer/src/panelLayout'

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value)
  }
}

describe('ui prefs persistence', () => {
  it('round-trips a saved layout', () => {
    const storage = memoryStorage()
    const prefs: UiPrefs = { tab: 'regions', width: 333, collapsed: ['info.affine'] }
    saveUiPrefs(prefs, storage)
    expect(loadUiPrefs(storage)).toEqual(prefs)
  })

  it('returns defaults when nothing is stored or the JSON is corrupt', () => {
    expect(loadUiPrefs(memoryStorage())).toEqual(defaultUiPrefs())
    const storage = memoryStorage()
    storage.map.set(UI_PREFS_KEY, '{not json')
    expect(loadUiPrefs(storage)).toEqual(defaultUiPrefs())
    storage.map.set(UI_PREFS_KEY, '"just a string"')
    expect(loadUiPrefs(storage)).toEqual(defaultUiPrefs())
  })

  it('falls back per field: unknown tab, bad width, bad collapsed entries', () => {
    const storage = memoryStorage()
    storage.map.set(UI_PREFS_KEY, JSON.stringify({ tab: 'nope', width: 'wide', collapsed: 'all' }))
    expect(loadUiPrefs(storage)).toEqual({
      tab: 'display',
      width: SIDE_PANEL_WIDTH_DEFAULT,
      collapsed: []
    })
    // A valid tab must survive a broken sibling field.
    storage.map.set(
      UI_PREFS_KEY,
      JSON.stringify({ tab: 'layers', width: NaN, collapsed: [1, 'a', null, 'b'] })
    )
    expect(loadUiPrefs(storage)).toEqual({
      tab: 'layers',
      width: SIDE_PANEL_WIDTH_DEFAULT,
      collapsed: ['a', 'b']
    })
  })

  it('clamps out-of-range stored widths on load', () => {
    const storage = memoryStorage()
    saveUiPrefs({ tab: 'display', width: 10_000, collapsed: [] }, storage)
    expect(loadUiPrefs(storage).width).toBe(SIDE_PANEL_WIDTH_MAX)
    saveUiPrefs({ tab: 'display', width: 1, collapsed: [] }, storage)
    expect(loadUiPrefs(storage).width).toBe(SIDE_PANEL_WIDTH_MIN)
  })

  it('swallows quota errors on save', () => {
    const setItem = vi.fn(() => {
      throw new Error('QuotaExceededError')
    })
    expect(() => saveUiPrefs(defaultUiPrefs(), { setItem })).not.toThrow()
    expect(setItem).toHaveBeenCalledTimes(1)
  })
})
