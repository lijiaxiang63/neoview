import { PERSISTED_STORAGE_KEYS } from '../../../shared/storageMigration'

/**
 * Per-file display preferences (preset choice + custom range), keyed by the
 * file's absolute path in localStorage. Reopening a file restores how it was
 * being viewed. LRU-capped so the store cannot grow without bound.
 */

export interface ViewPref {
  /** 'custom' restores {lo, hi} directly; other presets re-derive from stats. */
  preset: 'auto' | 'full' | 'fixed-0-80' | 'suggested' | 'custom'
  lo: number
  hi: number
}

const STORAGE_KEY = PERSISTED_STORAGE_KEYS[0]
export const VIEW_PREFS_MAX = 200

interface Payload {
  /** Insertion order = recency; the last key is the most recent. */
  entries: Record<string, ViewPref>
}

function readPayload(storage: Pick<Storage, 'getItem'>): Payload {
  try {
    const data: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? '')
    if (typeof data !== 'object' || data === null) return { entries: {} }
    const entries = (data as { entries?: unknown }).entries
    if (typeof entries !== 'object' || entries === null) return { entries: {} }
    return { entries: entries as Record<string, ViewPref> }
  } catch {
    return { entries: {} }
  }
}

function isValidPref(p: unknown): p is ViewPref {
  if (typeof p !== 'object' || p === null) return false
  const v = p as ViewPref
  return (
    ['auto', 'full', 'fixed-0-80', 'suggested', 'custom'].includes(v.preset) &&
    Number.isFinite(v.lo) &&
    Number.isFinite(v.hi)
  )
}

export function loadViewPref(path: string, storage: Pick<Storage, 'getItem'>): ViewPref | null {
  if (!path) return null
  const pref = readPayload(storage).entries[path]
  return isValidPref(pref) ? pref : null
}

export function saveViewPref(
  path: string,
  pref: ViewPref,
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  max = VIEW_PREFS_MAX
): void {
  if (!path) return
  const { entries } = readPayload(storage)
  // Re-inserting moves the key to the end (most recent) for the LRU cap.
  delete entries[path]
  entries[path] = pref
  const keys = Object.keys(entries)
  for (let i = 0; i < keys.length - max; i++) delete entries[keys[i]]
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ entries }))
  } catch {
    // Quota errors just mean the pref is not remembered.
  }
}
