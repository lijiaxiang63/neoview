import { clampPanelWidth, SIDE_PANEL_WIDTH_DEFAULT } from '../panelLayout'

/**
 * Panel layout preferences (active side-panel tab, panel width, collapsed
 * sections), stored under one localStorage key. Unlike per-file view prefs
 * these are application-wide and survive file changes.
 *
 * Deliberately NOT in PERSISTED_STORAGE_KEYS (shared/storageMigration.ts):
 * that list names keys that existed under the packaged renderer's former
 * file origin; this key was introduced after the origin change.
 */

export const SIDE_PANEL_TABS = ['display', 'regions', 'layers', 'info'] as const
export type SidePanelTab = (typeof SIDE_PANEL_TABS)[number]

export interface UiPrefs {
  tab: SidePanelTab
  width: number
  /** Ids of persisted collapsible sections that are collapsed (absent = open). */
  collapsed: string[]
}

export const UI_PREFS_KEY = 'neoview.uiPrefs.v1'

export function defaultUiPrefs(): UiPrefs {
  return { tab: 'display', width: SIDE_PANEL_WIDTH_DEFAULT, collapsed: [] }
}

function isTab(value: unknown): value is SidePanelTab {
  return (SIDE_PANEL_TABS as readonly unknown[]).includes(value)
}

/** Invalid fields fall back individually, so one bad value cannot discard
 * the rest of a stored layout. */
export function loadUiPrefs(storage: Pick<Storage, 'getItem'>): UiPrefs {
  try {
    const data: unknown = JSON.parse(storage.getItem(UI_PREFS_KEY) ?? '')
    if (typeof data !== 'object' || data === null) return defaultUiPrefs()
    const v = data as Record<string, unknown>
    return {
      tab: isTab(v.tab) ? v.tab : 'display',
      width: clampPanelWidth(typeof v.width === 'number' ? v.width : NaN),
      collapsed: Array.isArray(v.collapsed)
        ? v.collapsed.filter((id): id is string => typeof id === 'string')
        : []
    }
  } catch {
    return defaultUiPrefs()
  }
}

export function saveUiPrefs(prefs: UiPrefs, storage: Pick<Storage, 'setItem'>): void {
  try {
    storage.setItem(UI_PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // Quota errors just mean the layout is not remembered.
  }
}
