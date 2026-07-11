/** Pure application-settings payload contracts crossing process boundaries.
 * The main process owns the persisted file; renderers read a snapshot and
 * send validated patches back. */

/** Initial values applied to the segmentation panel when a volume loads.
 * `minVoxels` is deliberately absent: it is method-owned and overwritten by
 * the method defaults on every method switch, so persisting it would have no
 * effect. */
export interface SegDefaults {
  connectivity: 6 | 26
  slabDepth: number
  brushRadius: number
}

export interface AppSettings {
  /** Frame playback rate for multi-frame volumes. */
  playbackFps: number
  seg: SegDefaults
  /** Whether a newly added labels layer starts with its label list open. */
  expandLabelLists: boolean
}

export const PLAYBACK_FPS_MIN = 1
export const PLAYBACK_FPS_MAX = 30
export const PLAYBACK_FPS_DEFAULT = 8

/** Kept in sync with the renderer's brush limits (store/regionDomain.ts). */
export const BRUSH_RADIUS_MIN = 1
export const BRUSH_RADIUS_MAX = 30

/** Renderer-side shape of a settings write; main validates it field by field. */
export interface AppSettingsPatch {
  playbackFps?: number
  seg?: Partial<SegDefaults>
  expandLabelLists?: boolean
}

export const SETTINGS_CHANNELS = {
  get: 'app-settings-get',
  set: 'app-settings-set',
  changed: 'app-settings-changed'
} as const

export function defaultAppSettings(): AppSettings {
  return {
    playbackFps: PLAYBACK_FPS_DEFAULT,
    seg: { connectivity: 26, slabDepth: 9, brushRadius: 4 },
    expandLabelLists: true
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

function connectivityOf(value: unknown, fallback: 6 | 26): 6 | 26 {
  return value === 6 || value === 26 ? value : fallback
}

/** Field-by-field fallback: one malformed field never discards the rest. */
export function parseAppSettings(raw: unknown): AppSettings {
  const defaults = defaultAppSettings()
  if (typeof raw !== 'object' || raw === null) return defaults
  const record = raw as Record<string, unknown>
  const seg =
    typeof record.seg === 'object' && record.seg !== null
      ? (record.seg as Record<string, unknown>)
      : {}
  return {
    playbackFps: clampInt(
      record.playbackFps,
      PLAYBACK_FPS_MIN,
      PLAYBACK_FPS_MAX,
      defaults.playbackFps
    ),
    seg: {
      connectivity: connectivityOf(seg.connectivity, defaults.seg.connectivity),
      slabDepth: clampInt(seg.slabDepth, 1, Number.MAX_SAFE_INTEGER, defaults.seg.slabDepth),
      brushRadius: clampInt(
        seg.brushRadius,
        BRUSH_RADIUS_MIN,
        BRUSH_RADIUS_MAX,
        defaults.seg.brushRadius
      )
    },
    expandLabelLists:
      typeof record.expandLabelLists === 'boolean'
        ? record.expandLabelLists
        : defaults.expandLabelLists
  }
}

/** Apply an untrusted partial update on top of the current settings. Unknown
 * or malformed fields leave the current value untouched. */
export function patchAppSettings(current: AppSettings, patch: unknown): AppSettings {
  if (typeof patch !== 'object' || patch === null) return current
  const record = patch as Record<string, unknown>
  const seg =
    typeof record.seg === 'object' && record.seg !== null
      ? (record.seg as Record<string, unknown>)
      : {}
  return {
    playbackFps:
      'playbackFps' in record
        ? clampInt(record.playbackFps, PLAYBACK_FPS_MIN, PLAYBACK_FPS_MAX, current.playbackFps)
        : current.playbackFps,
    seg: {
      connectivity:
        'connectivity' in seg
          ? connectivityOf(seg.connectivity, current.seg.connectivity)
          : current.seg.connectivity,
      slabDepth:
        'slabDepth' in seg
          ? clampInt(seg.slabDepth, 1, Number.MAX_SAFE_INTEGER, current.seg.slabDepth)
          : current.seg.slabDepth,
      brushRadius:
        'brushRadius' in seg
          ? clampInt(seg.brushRadius, BRUSH_RADIUS_MIN, BRUSH_RADIUS_MAX, current.seg.brushRadius)
          : current.seg.brushRadius
    },
    expandLabelLists:
      typeof record.expandLabelLists === 'boolean'
        ? record.expandLabelLists
        : current.expandLabelLists
  }
}
