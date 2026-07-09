import { create } from 'zustand'
import type { Volume } from './volume/types'
import { sortEntries, type FolderEntry } from './files/folderList'
import { loadViewPref, saveViewPref, type ViewPref } from './files/viewPrefs'
import { defaultLayerSettings, guessOverlayKind, type OverlayLayer } from './slicing/overlay'
import { PLANES } from './slicing/extract'
import {
  AUTO_THRESHOLD_FALLBACK,
  boxHistogram,
  boxStats,
  boxVoxelCount,
  clampBox,
  clampTo,
  constraintFromLabelMap,
  constraintFromVolume,
  dilatedBox,
  GROW_BOUNDARY_RANGE,
  GROW_SEED_DEFAULT,
  GROW_SEED_RANGE,
  MAX_RESULT_VOXELS,
  otsuThreshold,
  segmentRegion,
  THRESHOLD_DEFAULT,
  THRESHOLD_RANGE,
  wholeVolumeBox,
  type Connectivity,
  type HistogramResult,
  type SegBox,
  type VoxelPredicate
} from './segmentation/segment'
import { PreviewClient } from './segmentation/previewClient'
import {
  applyMaskAsRegion,
  computeRegionStats,
  defaultRegionColor,
  eraseRegion,
  paintStroke,
  regionBoundingBox,
  type Region
} from './segmentation/regions'
import {
  applyPatchValues,
  ChangeCollector,
  patchFromErase,
  pushEntry,
  type HistoryEntry
} from './segmentation/history'

export type Preset = 'auto' | 'full' | 'fixed-0-80' | 'suggested' | 'custom'

export type RenderMode = 'mip' | 'composite'

/** Slice-view colormap for the base volume ('gray' = the fused fast path). */
export type BaseColormap = 'gray' | 'warm' | 'cool'

export interface HoverInfo {
  view: 0 | 1 | 2
  ijk: [number, number, number]
}

export type SegTool = 'crosshair' | 'box' | 'brush'
export type SegMethod = 'threshold' | 'grow'

export type SegConstraint =
  { type: 'none' } | { type: 'overlay'; overlayId: number } | { type: 'region'; regionId: number }

/**
 * Both methods drive one hysteresis engine. Threshold: the box surrounds the
 * region; low == high == the threshold and the flood stays box-bounded. Grow:
 * the box sits entirely inside the region; box voxels >= high seed a flood
 * that extends past the box down to the >= low boundary.
 */
export interface SegParams {
  method: SegMethod
  /** Boundary / grow-to threshold (scaled units); also THE threshold for the
   * threshold method. */
  low: number
  /** Seed threshold for the grow method (>= low). */
  high: number
  connectivity: Connectivity
  /** Connected pieces smaller than this are discarded (speck removal). */
  minVoxels: number
  /** How far the grow may reach past the box (voxels); null = unlimited.
   * Ignored for the threshold method and when a constraint bounds the flood. */
  growMargin: number | null
  constraint: SegConstraint
}

export interface SegPreview {
  /** Selected voxels over `bounds` (the box, or the grow reach). */
  mask: Uint8Array
  bounds: SegBox
  voxels: number
  /** Connected pieces surviving the size filter. */
  components: number
  /** The safety cap stopped a runaway grow. */
  truncated: boolean
  /** Box ∩ constraint intensity stats at compute time. */
  domain: { min: number; max: number; mean: number }
  /** Box ∩ constraint histogram for the panel (threshold markers overlay it). */
  histogram: HistogramResult
}

export interface ToastState {
  text: string
  /** Colors the card's severity edge; defaults to 'info'. */
  variant?: 'info' | 'success' | 'error'
  action?: { label: string; kind: 'undo' } | { label: string; kind: 'reveal'; path: string }
}

/** A queued toast with a stable id for keying and targeted dismissal. */
export interface ToastItem extends ToastState {
  id: number
}

/** What a commit was made from, so re-editing restores the drawn box and the
 * tuned parameters instead of starting over. */
export interface SegSnapshot {
  box: SegBox
  slabAxis: 0 | 1 | 2 | null
  params: SegParams
}

/** An opened folder of volume files, shown in the file panel. */
export interface FolderState {
  root: string
  /** Pre-sorted by the caller (see files/folderList.ts#sortEntries). */
  files: FolderEntry[]
  /** True when the scan stopped at its file cap. */
  truncated: boolean
}

interface AppState {
  volume: Volume | null
  /** Absolute path of the opened base file (null for unknown origins). */
  sourcePath: string | null
  /** Opened folder; cleared when a base volume from outside it loads. */
  folder: FolderState | null
  /** True while a folder scan is in flight (feedback + re-entry guard). */
  folderLoading: boolean
  /** File list visibility; the folder stays open while the panel is hidden. */
  filePanelOpen: boolean
  /** Side panel visibility (a viewing pref — survives file changes). */
  sidePanelOpen: boolean
  /** Navigation target still being read/loaded (arrow-key scrubbing). */
  pendingFilePath: string | null
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
  /** Base-volume slice colormap (a viewing pref — survives file changes). */
  baseColormap: BaseColormap
  /** Case-insensitive substring filter over the file panel's list. */
  fileFilter: string
  /** The modal shortcuts dialog. In the store so transient popups (region
   * context menu) can dismiss themselves when it opens above them. */
  shortcutsOpen: boolean
  /** Overlay layers in draw order: index 0 is the bottom-most. */
  overlays: OverlayLayer[]

  // Region segmentation. All regions share one label map on the base grid
  // (region id per voxel); the array mutates in place and labelMapRev bumps
  // on every edit so views know to redraw.
  labelMap: Uint16Array | null
  labelMapRev: number
  regions: Region[]
  nextRegionId: number
  activeRegionId: number | null
  segTool: SegTool
  segBox: SegBox | null
  /** Region whose voxels the next commit REPLACES (re-edit flow); null = the
   * commit creates a new region. */
  editRegionId: number | null
  /** Per-region commit snapshots, keyed by region id. */
  segSnapshots: Record<number, SegSnapshot>
  /** Slice view currently maximized over the workspace (double-click). */
  maximizedView: 0 | 1 | 2 | null
  /** The axis the box was drawn through (its slab), for the slab-depth input. */
  segSlabAxis: 0 | 1 | 2 | null
  /** Through-plane extent given to a freshly drawn box (voxels, kept odd). */
  slabDepth: number
  segParams: SegParams
  preview: SegPreview | null
  brushRadius: number
  regionOpacity: number
  /** True while region edits exist that have not been exported. */
  segDirty: boolean
  /** Source paths whose regions were exported this session. Marks file-panel
   * rows even when the export file lands outside the opened folder. */
  exportedPaths: ReadonlySet<string>
  /** Region-edit history (paint strokes, commits, deletes) as value patches;
   * any edit clears the redo stack. Reset with the label map on base change. */
  undoStack: HistoryEntry<SegSnapshot>[]
  redoStack: HistoryEntry<SegSnapshot>[]
  /** Transient notifications shown as a bottom-right stack (oldest first). */
  toasts: ToastItem[]

  startLoading: () => void
  setVolume: (v: Volume, sourcePath?: string | null) => void
  setFolder: (f: FolderState) => void
  /** Merge a streamed scan batch into the opened folder (kept sorted). */
  appendFolderFiles: (root: string, files: FolderEntry[]) => void
  closeFolder: () => void
  setFolderLoading: (b: boolean) => void
  toggleFilePanel: () => void
  toggleSidePanel: () => void
  setPendingFilePath: (p: string | null) => void
  addOverlay: (v: Volume) => void
  removeOverlay: (id: number) => void
  updateOverlay: (id: number, patch: Partial<Omit<OverlayLayer, 'id' | 'volume'>>) => void
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
  setBaseColormap: (c: BaseColormap) => void
  setFileFilter: (q: string) => void
  setShortcutsOpen: (open: boolean) => void

  setSegTool: (t: SegTool) => void
  setSegBox: (box: SegBox | null) => void
  /** A drag finished creating a box: record its slab axis and derive
   * data-driven thresholds for the current method. */
  finalizeBox: (box: SegBox, slabAxis: 0 | 1 | 2) => void
  /** Re-extend the box along its slab axis, centered where it is. */
  setSlabDepth: (d: number) => void
  /** Derive low/high for the current method from the box (Otsu / box mean). */
  initSegDefaults: () => void
  /** Switch methods, applying that method's parameter defaults. */
  applyMethod: (m: SegMethod) => void
  /** Set a threshold from the box ∩ constraint: Otsu drives the (boundary)
   * threshold, the box mean drives the grow seed level. */
  autoThreshold: (kind: 'otsu' | 'mean') => void
  setSegParams: (patch: Partial<SegParams>) => void
  commitPreview: () => void
  cancelSeg: () => void
  paintAt: (view: 0 | 1 | 2, from: [number, number], to: [number, number], erase: boolean) => void
  endStroke: () => void
  setBrushRadius: (r: number) => void
  setRegionOpacity: (o: number) => void
  setActiveRegion: (id: number | null) => void
  /** Re-open a region for segmentation editing: box = its bounding box, the
   * next commit replaces its voxels (name/color/visibility kept). */
  editRegion: (id: number) => void
  toggleMaximized: (view: 0 | 1 | 2) => void
  updateRegion: (id: number, patch: Partial<Pick<Region, 'name' | 'color' | 'visible'>>) => void
  deleteRegion: (id: number) => void
  /** Undo/redo the most recent region edit (no-ops on empty stacks). */
  undo: () => void
  redo: () => void
  /** An export finished writing. Both arguments are captured when the export
   * STARTS: the write is async, and reading current state here instead would
   * attribute the export to whatever file the user navigated to meanwhile.
   * Clears the dirty flag only while `volume` is still the loaded one. */
  markExported: (volume: Volume, sourcePath: string | null) => void
  /** Append a toast to the stack; returns its id so callers can dismiss it. */
  pushToast: (t: ToastState) => number
  dismissToast: (id: number) => void
}

export const DENSITY_MIN = 0.02
export const DENSITY_MAX = 1
export const BRIGHTNESS_MIN = 0.05
export const BRIGHTNESS_MAX = 1
export const BRIGHTNESS_DEFAULT = 0.45
export const BRUSH_RADIUS_MIN = 1
export const BRUSH_RADIUS_MAX = 30

export const SLAB_DEPTH_DEFAULT = 9
/** Display resolution of the panel's box histogram. */
const HISTOGRAM_BINS = 96

const DEFAULT_SEG_PARAMS: SegParams = {
  method: 'threshold',
  low: THRESHOLD_DEFAULT,
  high: THRESHOLD_DEFAULT,
  connectivity: 26,
  minVoxels: 3,
  growMargin: null,
  constraint: { type: 'none' }
}

/** Per-method parameter defaults applied on a method switch (thresholds are
 * re-derived from the box separately). */
const METHOD_DEFAULTS: Record<SegMethod, Partial<SegParams>> = {
  threshold: { minVoxels: 3 },
  grow: { minVoxels: 1, growMargin: null }
}

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

/** Voxel-count fields stay whole (fractional margins would corrupt integer
 * box geometry) and grow's seed (high) stays >= boundary (low). `edited`
 * names the threshold the caller changed; on a crossing the other follows,
 * so the panel always shows exactly what will be computed. */
export function normalizeSegParams(p: SegParams, edited: 'low' | 'high'): SegParams {
  const out = { ...p }
  if (out.growMargin !== null) out.growMargin = Math.max(0, Math.round(out.growMargin))
  out.minVoxels = Math.max(1, Math.round(out.minVoxels))
  if (out.low > out.high) {
    if (edited === 'high') out.low = out.high
    else out.high = out.low
  }
  return out
}

/** The runaway-flood safety cap applies only where the flood may roam the
 * whole volume: a grow whose effective bounds cover it, whether explicitly
 * (constraint present, unlimited reach) or via a margin large enough to
 * clamp to it. A user-drawn threshold box or a genuinely partial margin
 * bounds the work already, and truncating those would silently commit a
 * partial mask. */
export function floodCap(p: SegParams, boundsVoxels: number, volumeVoxels: number): number {
  return p.method === 'grow' && boundsVoxels >= volumeVoxels ? MAX_RESULT_VOXELS : Infinity
}

/** Unsaved region edits exist (drives the replace/close confirmation).
 * Deleting the last region is still an unsaved edit — a previously exported
 * file would keep voxels the user just removed. */
export function hasUnsavedRegions(): boolean {
  return useStore.getState().segDirty
}

// Never reset: layer ids must stay unique across base changes for React keys.
let nextOverlayId = 1

// localStorage is absent in the unit-test environment; prefs just no-op there.
const prefStorage: Pick<Storage, 'getItem' | 'setItem'> | null =
  typeof localStorage === 'undefined' ? null : localStorage
let prefSaveTimer: ReturnType<typeof setTimeout> | undefined
// The capture waiting out the debounce. Prefs are keyed per file, so a
// file switch must FLUSH this (write it now), never cancel it.
let pendingPrefSave: { path: string; pref: ViewPref } | null = null

// The brush gesture in flight: paintAt fills it, endStroke folds it into one
// undo entry. Module-level because a stroke spans many store actions.
let strokeCollector: ChangeCollector | null = null

// Monotonic toast id; the notification stack keys and dismisses by it.
let nextToastId = 0

// A toast's Undo button fires the global undo, i.e. the top of the undo
// stack; pushing a new entry retargets that, so every push must drop any
// still-visible undo toast (its button would revert the newer edit).
const dropUndoToasts = (toasts: ToastItem[]): ToastItem[] =>
  toasts.filter((t) => t.action?.kind !== 'undo')

// Preview recomputes are debounced so box drags and slider scrubs stay fluid;
// the box-sized compute happens at most once per delay window.
let previewTimer: ReturnType<typeof setTimeout> | undefined
// True while an input change has not been reflected in `preview` yet, so a
// commit can recompute synchronously instead of applying a stale mask.
let previewPending = false
// Monotonic ticket: only the newest preview computation (sync or worker) may
// publish; every newer computation and every cancellation bumps it.
let previewToken = 0
// Large floods run in a persistent worker so threshold scrubbing over big
// bounds cannot jank the UI; small bounds stay synchronous (lower latency,
// no buffer mirroring).
const previewClient = new PreviewClient()
const WORKER_MIN_BOUNDS_VOXELS = 4 * 1024 * 1024

function frameOffsetOf(vol: Volume, frame: number): number {
  const n = vol.dims[0] * vol.dims[1] * vol.dims[2]
  return Math.min(frame, vol.frames - 1) * n
}

export const useStore = create<AppState>()((set, get) => {
  /** The active constraint as a per-voxel predicate (null = unconstrained). */
  function constraintPredicate(): VoxelPredicate | null {
    const s = get()
    const vol = s.volume
    if (!vol) return null
    const c = s.segParams.constraint
    if (c.type === 'overlay') {
      const layer = s.overlays.find((l) => l.id === c.overlayId)
      return layer ? constraintFromVolume(vol, layer.volume, s.frame) : null
    }
    if (c.type === 'region' && s.labelMap) {
      return constraintFromLabelMap(s.labelMap, vol.dims, c.regionId)
    }
    return null
  }

  /** Where the flood may expand: the box itself for thresholding; for grow,
   * the whole volume when a constraint bounds it (or the reach is
   * unlimited), else the box dilated by the margin. */
  function floodBounds(vol: Volume, box: SegBox, p: SegParams, constrained: boolean): SegBox {
    if (p.method !== 'grow') return box
    return constrained || p.growMargin === null
      ? wholeVolumeBox(vol.dims)
      : clampBox(dilatedBox(box, p.growMargin), vol.dims)
  }

  /** The engine parameters exactly as the panel shows them (normalizeSegParams
   * keeps high >= low, so no silent swap here). */
  function engineParams(
    vol: Volume,
    p: SegParams,
    bounds: SegBox
  ): {
    low: number
    high: number
    connectivity: Connectivity
    minVoxels: number
    maxVoxels: number
  } {
    return {
      low: p.low,
      high: p.method === 'threshold' ? p.low : p.high,
      connectivity: p.connectivity,
      minVoxels: p.minVoxels,
      maxVoxels: floodCap(p, boxVoxelCount(bounds), vol.dims[0] * vol.dims[1] * vol.dims[2])
    }
  }

  function publishPreview(
    result: {
      mask: Uint8Array
      bounds: SegBox
      voxels: number
      components: number
      truncated: boolean
    },
    domain: { min: number; max: number; mean: number },
    histogram: HistogramResult
  ): void {
    set({
      preview: {
        mask: result.mask,
        bounds: result.bounds,
        voxels: result.voxels,
        components: result.components,
        truncated: result.truncated,
        domain,
        histogram
      }
    })
  }

  /** Synchronous compute — the canonical path (commits fold pending edits in
   * through it). Bumping the token invalidates any worker compute in flight. */
  function computePreviewNow(): void {
    previewPending = false
    previewToken++
    const s = get()
    const vol = s.volume
    if (!vol || !s.segBox) {
      if (s.preview) set({ preview: null })
      return
    }
    const box = s.segBox
    const p = s.segParams
    const frameOffset = frameOffsetOf(vol, s.frame)
    const constraint = constraintPredicate()
    const domain = boxStats(vol, box, frameOffset, constraint)
    const bounds = floodBounds(vol, box, p, constraint !== null)
    const result = segmentRegion(
      vol,
      box,
      bounds,
      engineParams(vol, p, bounds),
      frameOffset,
      constraint
    )
    publishPreview(result, domain, boxHistogram(vol, box, HISTOGRAM_BINS, frameOffset, constraint))
  }

  /** Debounce target: route big floods to the preview worker, everything
   * else (and every worker miss/failure) to the synchronous path. */
  function computePreview(): void {
    const s = get()
    const vol = s.volume
    if (!vol || !s.segBox) {
      computePreviewNow()
      return
    }
    const box = s.segBox
    const p = s.segParams
    const constraint = constraintPredicate()
    const bounds = floodBounds(vol, box, p, constraint !== null)
    if (!previewClient.available() || boxVoxelCount(bounds) < WORKER_MIN_BOUNDS_VOXELS) {
      computePreviewNow()
      return
    }
    // The box-bounded extras (histogram, stats) stay on the main thread —
    // they are cheap next to the flood the worker is taking over.
    const frameOffset = frameOffsetOf(vol, s.frame)
    const domain = boxStats(vol, box, frameOffset, constraint)
    const histogram = boxHistogram(vol, box, HISTOGRAM_BINS, frameOffset, constraint)
    const token = ++previewToken
    const posted = previewClient.request(
      vol,
      s.labelMap,
      s.labelMapRev,
      s.overlays,
      {
        token,
        box,
        bounds,
        params: engineParams(vol, p, bounds),
        frameOffset,
        frame: s.frame,
        constraint: p.constraint
      },
      (respToken, result) => {
        // -1 = the worker itself died; recover synchronously if still wanted.
        if (respToken === -1) {
          if (token === previewToken) computePreviewNow()
          return
        }
        if (respToken !== previewToken) return
        if (!result) {
          computePreviewNow()
          return
        }
        const now = get()
        if (now.volume !== vol || !now.segBox) return
        previewPending = false
        publishPreview(result, domain, histogram)
      }
    )
    if (!posted) computePreviewNow()
  }

  function schedulePreview(): void {
    previewPending = true
    // A newer input supersedes any worker compute in flight: bump the token so
    // its late result is dropped instead of overwriting the pending state.
    previewToken++
    clearTimeout(previewTimer)
    previewTimer = setTimeout(computePreview, 90)
  }

  function cancelScheduledPreview(): void {
    previewPending = false
    previewToken++
    clearTimeout(previewTimer)
  }

  /**
   * Undo/redo share one engine: pop an entry, apply its before/after values
   * to the label map, restore the matching region list (stats recomputed —
   * an entry may overlap regions it did not create), and move the entry to
   * the opposite stack. Anything pointing at a region that no longer exists
   * (active/edit selection, a region constraint) is cleared.
   */
  function applyHistory(dir: 'undo' | 'redo'): void {
    const s = get()
    const vol = s.volume
    const stack = dir === 'undo' ? s.undoStack : s.redoStack
    const entry = stack[stack.length - 1]
    if (!vol || !entry) return
    const labelMap = s.labelMap
    if (entry.patch && labelMap) {
      applyPatchValues(
        labelMap,
        entry.patch.indices,
        dir === 'undo' ? entry.patch.before : entry.patch.after
      )
    }
    // The snapshot decides which regions exist; metadata (name/color/
    // visibility) is deliberately outside history, so a region that still
    // exists keeps its CURRENT fields — only resurrected regions come from
    // the snapshot wholesale. Stats are recomputed below either way.
    const snapshot = entry.regions ? entry.regions[dir === 'undo' ? 'before' : 'after'] : s.regions
    const list = snapshot.map((r) => s.regions.find((c) => c.id === r.id) ?? r)
    const regions = labelMap
      ? computeRegionStats(vol, labelMap, list, frameOffsetOf(vol, s.frame))
      : list
    const stillThere = (id: number | null): boolean =>
      id !== null && regions.some((r) => r.id === id)
    // A commit rewrote its region's saved snapshot; put the matching side
    // back (undefined = none existed, so the key goes away).
    let segSnapshots = s.segSnapshots
    if (entry.snapshot) {
      const snap = dir === 'undo' ? entry.snapshot.before : entry.snapshot.after
      segSnapshots = { ...s.segSnapshots }
      if (snap === undefined) delete segSnapshots[entry.snapshot.id]
      else segSnapshots[entry.snapshot.id] = snap
    }
    set({
      labelMapRev: s.labelMapRev + 1,
      regions,
      segSnapshots,
      nextRegionId: entry.nextId
        ? entry.nextId[dir === 'undo' ? 'before' : 'after']
        : s.nextRegionId,
      undoStack: dir === 'undo' ? s.undoStack.slice(0, -1) : [...s.undoStack, entry],
      redoStack: dir === 'undo' ? [...s.redoStack, entry] : s.redoStack.slice(0, -1),
      activeRegionId: stillThere(s.activeRegionId) ? s.activeRegionId : null,
      editRegionId: stillThere(s.editRegionId) ? s.editRegionId : null,
      segDirty: true,
      // The popped entry is what a lingering undo toast pointed at; other
      // toasts (export reveals) are unaffected by history moves.
      toasts: dropUndoToasts(s.toasts)
    })
    const c = get().segParams.constraint
    if (c.type === 'region' && !regions.some((r) => r.id === c.regionId)) {
      // setSegParams reschedules the preview itself.
      get().setSegParams({ constraint: { type: 'none' } })
    } else if (get().segBox) {
      schedulePreview()
    }
  }

  /** Write the pending capture immediately (idempotent). Runs on the timer,
   * and from setVolume so a file switch inside the debounce window can
   * neither misattribute the save nor drop it. */
  function flushPrefSave(): void {
    clearTimeout(prefSaveTimer)
    if (!pendingPrefSave || !prefStorage) return
    saveViewPref(pendingPrefSave.path, pendingPrefSave.pref, prefStorage)
    pendingPrefSave = null
  }

  /** Debounced write of the current display range/preset to the per-file
   * prefs (drag gestures fire setRange every frame). Path and values are
   * captured NOW: the debounce only ever coalesces edits to the same file,
   * because setVolume flushes before the path can change. */
  function schedulePrefSave(): void {
    if (!prefStorage) return
    const s = get()
    if (!s.volume || !s.sourcePath) return
    pendingPrefSave = {
      path: s.sourcePath,
      pref: { preset: s.activePreset, lo: s.range.lo, hi: s.range.hi }
    }
    clearTimeout(prefSaveTimer)
    prefSaveTimer = setTimeout(flushPrefSave, 300)
  }

  /** Grow's seed level: the box mean (the box is, by contract, entirely
   * region), clamped to the seed tuning range; the fixed default without a
   * usable box. */
  function seedFromBox(): number {
    const s = get()
    const vol = s.volume
    if (!vol || !s.segBox) return GROW_SEED_DEFAULT
    const stats = boxStats(vol, s.segBox, frameOffsetOf(vol, s.frame), constraintPredicate())
    return stats.count > 0 ? clampTo(stats.mean, GROW_SEED_RANGE) : GROW_SEED_DEFAULT
  }

  return {
    volume: null,
    sourcePath: null,
    folder: null,
    folderLoading: false,
    filePanelOpen: true,
    sidePanelOpen: true,
    pendingFilePath: null,
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
    baseColormap: 'gray',
    fileFilter: '',
    shortcutsOpen: false,
    overlays: [],

    labelMap: null,
    labelMapRev: 0,
    regions: [],
    nextRegionId: 1,
    activeRegionId: null,
    segTool: 'crosshair',
    segBox: null,
    editRegionId: null,
    segSnapshots: {},
    maximizedView: null,
    segSlabAxis: null,
    slabDepth: SLAB_DEPTH_DEFAULT,
    segParams: DEFAULT_SEG_PARAMS,
    preview: null,
    brushRadius: 4,
    regionOpacity: 0.5,
    segDirty: false,
    exportedPaths: new Set<string>(),
    undoStack: [],
    redoStack: [],
    toasts: [],

    startLoading: () => set({ loadState: 'loading', errorMessage: null }),

    // A fresh folder starts with an empty filter — a leftover query would
    // silently hide the new list.
    setFolder: (f) =>
      set((s) => ({
        folder: f,
        filePanelOpen: true,
        // A streaming scan calls this again with its final list; a filter
        // typed meanwhile must survive. Only a different folder resets it.
        fileFilter: s.folder && s.folder.root === f.root ? s.fileFilter : ''
      })),

    appendFolderFiles: (root, files) =>
      set((s) => {
        if (!s.folder || s.folder.root !== root) return {}
        // Batches never overlap, but dedup anyway so a stray repeat is inert.
        const seen = new Set(s.folder.files.map((f) => f.path))
        const fresh = files.filter((f) => !seen.has(f.path))
        if (fresh.length === 0) return {}
        return { folder: { ...s.folder, files: sortEntries([...s.folder.files, ...fresh]) } }
      }),

    closeFolder: () => set({ folder: null }),

    setFolderLoading: (b) => set({ folderLoading: b }),

    toggleFilePanel: () => set((s) => ({ filePanelOpen: !s.filePanelOpen })),

    toggleSidePanel: () => set((s) => ({ sidePanelOpen: !s.sidePanelOpen })),

    setPendingFilePath: (p) => set({ pendingFilePath: p }),

    setVolume: (v, sourcePath = null) => {
      cancelScheduledPreview()
      // The outgoing file's pending pref save must land under ITS path (and
      // before this file's pref is read back, in case it is the same file).
      flushPrefSave()
      // A remembered per-file preference wins over the load heuristic; the
      // custom preset restores its exact range, named presets re-derive from
      // this file's stats.
      const saved = sourcePath && prefStorage ? loadViewPref(sourcePath, prefStorage) : null
      let preset: Preset
      let range: { lo: number; hi: number }
      if (saved) {
        preset = saved.preset
        range =
          saved.preset === 'custom' ? { lo: saved.lo, hi: saved.hi } : presetRange(v, saved.preset)
      } else {
        const p = pickInitialPreset(v)
        preset = p
        range = presetRange(v, p)
      }
      set((s) => ({
        volume: v,
        sourcePath,
        // A base volume from outside the opened folder replaces it entirely:
        // the file list only makes sense while browsing within that folder.
        folder:
          s.folder && sourcePath !== null && s.folder.files.some((f) => f.path === sourcePath)
            ? s.folder
            : null,
        loadState: 'ready',
        errorMessage: null,
        cross: [Math.floor(v.dims[0] / 2), Math.floor(v.dims[1] / 2), Math.floor(v.dims[2] / 2)],
        frame: 0,
        range,
        activePreset: preset,
        hover: null,
        // A new base means a new grid: keeping layers would silently misalign
        // them, so they are dropped (also frees their memory promptly).
        overlays: [],
        // Same reasoning for regions — they live on the old grid.
        labelMap: null,
        labelMapRev: 0,
        regions: [],
        nextRegionId: 1,
        activeRegionId: null,
        segTool: 'crosshair',
        segBox: null,
        editRegionId: null,
        segSnapshots: {},
        maximizedView: null,
        segSlabAxis: null,
        preview: null,
        segParams: DEFAULT_SEG_PARAMS,
        segDirty: false,
        undoStack: [],
        redoStack: [],
        toasts: []
      }))
    },

    addOverlay: (v) => {
      const kind = guessOverlayKind(v)
      const { range, colormap } = defaultLayerSettings(v)
      const layer: OverlayLayer = {
        id: nextOverlayId++,
        volume: v,
        kind,
        visible: true,
        opacity: 0.6,
        range,
        colormap,
        hiddenLabels: new Set()
      }
      set((s) => ({ overlays: [...s.overlays, layer], loadState: 'ready', errorMessage: null }))
    },

    removeOverlay: (id) => {
      set((s) => ({ overlays: s.overlays.filter((l) => l.id !== id) }))
      // A constraint pointing at the removed layer would silently pin the
      // preview to stale data.
      const { segParams } = get()
      if (segParams.constraint.type === 'overlay' && segParams.constraint.overlayId === id) {
        get().setSegParams({ constraint: { type: 'none' } })
      }
    },

    updateOverlay: (id, patch) =>
      set((s) => ({
        overlays: s.overlays.map((l) => (l.id === id ? { ...l, ...patch } : l))
      })),

    fail: (message) =>
      set((s) => ({
        errorMessage: message,
        loadState: s.volume ? 'ready' : 'error'
      })),

    dismissError: () =>
      set((s) => ({ errorMessage: null, loadState: s.volume ? 'ready' : 'empty' })),

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
      const s = get()
      const vol = s.volume
      if (!vol) return
      const frame = Math.min(Math.max(t, 0), vol.frames - 1)
      // Region stats are per-frame; keep them in step with the slices.
      const regions =
        frame !== s.frame && s.labelMap && s.regions.length > 0
          ? computeRegionStats(vol, s.labelMap, s.regions, frameOffsetOf(vol, frame))
          : s.regions
      set({ frame, regions })
      if (s.segBox) schedulePreview()
    },

    setRange: (lo, hi) => {
      set({ range: { lo, hi }, activePreset: 'custom' })
      schedulePrefSave()
    },

    applyPreset: (p) => {
      const vol = get().volume
      if (!vol) return
      set({ range: presetRange(vol, p), activePreset: p })
      schedulePrefSave()
    },

    setHover: (h) => set({ hover: h }),

    setRenderMode: (m) => set({ renderMode: m }),

    setDensity: (d) => set({ density: Math.min(DENSITY_MAX, Math.max(DENSITY_MIN, d)) }),

    setBrightness: (b) =>
      set({ brightness: Math.min(BRIGHTNESS_MAX, Math.max(BRIGHTNESS_MIN, b)) }),

    setBaseColormap: (c) => set({ baseColormap: c }),

    setFileFilter: (q) => set({ fileFilter: q }),

    setShortcutsOpen: (open) => set({ shortcutsOpen: open }),

    // ---- Region segmentation ------------------------------------------------

    setSegTool: (t) => set({ segTool: t }),

    setSegBox: (box) => {
      const vol = get().volume
      if (!vol) return
      if (!box) {
        cancelScheduledPreview()
        set({ segBox: null, preview: null })
        return
      }
      set({ segBox: clampBox(box, vol.dims) })
      schedulePreview()
    },

    finalizeBox: (box, slabAxis) => {
      const vol = get().volume
      if (!vol) return
      set({ segBox: clampBox(box, vol.dims), segSlabAxis: slabAxis })
      get().initSegDefaults()
    },

    setSlabDepth: (d) => {
      const s = get()
      const vol = s.volume
      const depth = Math.max(1, Math.round(d))
      set({ slabDepth: depth })
      if (!vol || !s.segBox || s.segSlabAxis === null) return
      const a = s.segSlabAxis
      const center = Math.round((s.segBox.min[a] + s.segBox.max[a]) / 2)
      const half = Math.floor(depth / 2)
      const box: SegBox = { min: [...s.segBox.min], max: [...s.segBox.max] }
      box.min[a] = center - half
      box.max[a] = center + half
      get().setSegBox(box)
    },

    initSegDefaults: () => {
      const s = get()
      if (!s.volume || !s.segBox) return
      // Thresholds live on fixed tuning scales, so a new box only refreshes
      // what is box-derived: grow's seed level.
      if (s.segParams.method === 'grow') {
        set({ segParams: normalizeSegParams({ ...s.segParams, high: seedFromBox() }, 'high') })
      }
      schedulePreview()
    },

    applyMethod: (m) => {
      const s = get()
      const p = s.segParams
      let low: number
      let high: number
      if (m === 'threshold') {
        low = clampTo(p.low, THRESHOLD_RANGE)
        high = low
      } else {
        low = clampTo(p.low, GROW_BOUNDARY_RANGE)
        high = seedFromBox()
      }
      // The seed comes from the box data, so on a crossing it wins.
      set({
        segParams: normalizeSegParams({ ...p, ...METHOD_DEFAULTS[m], low, high, method: m }, 'high')
      })
      if (get().segBox) schedulePreview()
    },

    autoThreshold: (kind) => {
      const s = get()
      const vol = s.volume
      if (!vol || !s.segBox) return
      const frameOffset = frameOffsetOf(vol, s.frame)
      const constraint = constraintPredicate()
      if (s.segParams.method === 'threshold') {
        const stats = boxStats(vol, s.segBox, frameOffset, constraint)
        const value =
          kind === 'otsu'
            ? otsuThreshold(vol, s.segBox, frameOffset, constraint)
            : stats.count > 0
              ? stats.mean
              : AUTO_THRESHOLD_FALLBACK
        const v = clampTo(value, THRESHOLD_RANGE)
        get().setSegParams({ low: v, high: v })
      } else if (kind === 'otsu') {
        const value = otsuThreshold(vol, s.segBox, frameOffset, constraint)
        get().setSegParams({ low: clampTo(value, GROW_BOUNDARY_RANGE) })
      } else {
        get().setSegParams({ high: seedFromBox() })
      }
    },

    setSegParams: (patch) => {
      const edited = patch.high !== undefined && patch.low === undefined ? 'high' : 'low'
      set((s) => ({ segParams: normalizeSegParams({ ...s.segParams, ...patch }, edited) }))
      if (get().segBox) schedulePreview()
    },

    commitPreview: () => {
      // A commit racing the debounce would apply the mask of the previous
      // parameters/frame/box; fold pending edits in first.
      if (previewPending) computePreviewNow()
      const s = get()
      const vol = s.volume
      if (!vol || !s.preview || s.preview.voxels === 0) return
      const n = vol.dims[0] * vol.dims[1] * vol.dims[2]
      const labelMap = s.labelMap ?? new Uint16Array(n)
      // Re-edit flow: the commit replaces the target region's voxels and
      // keeps its identity (name/color/visibility).
      const editing = s.editRegionId !== null && s.regions.some((r) => r.id === s.editRegionId)
      const id = editing ? (s.editRegionId as number) : s.nextRegionId
      const changes = new ChangeCollector()
      if (editing) {
        const erased = eraseRegion(labelMap, id)
        for (let i = 0; i < erased.length; i++) changes.record(erased[i], id)
      }
      applyMaskAsRegion(labelMap, vol.dims, s.preview.bounds, s.preview.mask, id, changes)
      const list = editing
        ? s.regions
        : [
            ...s.regions,
            {
              id,
              name: `Region ${id}`,
              color: defaultRegionColor(id),
              visible: true,
              voxelCount: 0,
              stats: null
            } satisfies Region
          ]
      // Committing can overwrite voxels of earlier regions, so all stats
      // refresh together.
      const regions = computeRegionStats(vol, labelMap, list, frameOffsetOf(vol, s.frame))
      // Remember what this region was cut from, so re-editing restores the
      // drawn box and tuned parameters. The old/new pair rides the history
      // entry so undo/redo keep the snapshot in step with the voxels.
      const snap: SegSnapshot | null = s.segBox
        ? { box: s.segBox, slabAxis: s.segSlabAxis, params: s.segParams }
        : null
      const entry: HistoryEntry<SegSnapshot> = {
        patch: changes.finish(labelMap),
        regions: { before: s.regions, after: regions },
        nextId: { before: s.nextRegionId, after: editing ? s.nextRegionId : id + 1 },
        ...(snap ? { snapshot: { id, before: s.segSnapshots[id], after: snap } } : {})
      }
      const segSnapshots = snap ? { ...s.segSnapshots, [id]: snap } : s.segSnapshots
      // The box is consumed by the commit; the tool drops back to navigation.
      cancelScheduledPreview()
      set({
        labelMap,
        labelMapRev: s.labelMapRev + 1,
        regions,
        segSnapshots,
        nextRegionId: editing ? s.nextRegionId : id + 1,
        activeRegionId: id,
        segBox: null,
        segSlabAxis: null,
        preview: null,
        editRegionId: null,
        segTool: 'crosshair',
        segDirty: true,
        undoStack: pushEntry(s.undoStack, entry),
        redoStack: [],
        toasts: dropUndoToasts(s.toasts)
      })
    },

    cancelSeg: () => {
      cancelScheduledPreview()
      set({ segBox: null, segSlabAxis: null, preview: null, editRegionId: null })
    },

    paintAt: (view, from, to, erase) => {
      const s = get()
      const vol = s.volume
      if (!vol || !s.labelMap || s.activeRegionId === null) return
      const plane = PLANES[view]
      // One collector per stroke: created on the first stamp, consumed by
      // endStroke into a single undo entry.
      if (!strokeCollector) strokeCollector = new ChangeCollector()
      paintStroke(
        s.labelMap,
        vol.dims,
        plane,
        s.cross[plane.sliceAxis],
        from,
        to,
        s.brushRadius,
        s.activeRegionId,
        erase,
        strokeCollector
      )
      set({ labelMapRev: s.labelMapRev + 1, segDirty: true })
    },

    endStroke: () => {
      const s = get()
      const vol = s.volume
      const patch = s.labelMap && strokeCollector ? strokeCollector.finish(s.labelMap) : null
      strokeCollector = null
      if (!vol || !s.labelMap || s.regions.length === 0) return
      set({
        regions: computeRegionStats(vol, s.labelMap, s.regions, frameOffsetOf(vol, s.frame)),
        ...(patch
          ? {
              undoStack: pushEntry(s.undoStack, { patch }),
              redoStack: [],
              toasts: dropUndoToasts(s.toasts)
            }
          : {})
      })
      // Painting changes region shapes; a region-constrained preview must follow.
      if (s.segBox && s.segParams.constraint.type === 'region') schedulePreview()
    },

    setBrushRadius: (r) =>
      set({ brushRadius: Math.min(BRUSH_RADIUS_MAX, Math.max(BRUSH_RADIUS_MIN, Math.round(r))) }),

    setRegionOpacity: (o) => set({ regionOpacity: Math.min(1, Math.max(0, o)) }),

    setActiveRegion: (id) => set({ activeRegionId: id }),

    editRegion: (id) => {
      const s = get()
      const vol = s.volume
      if (!vol || !s.labelMap || !s.regions.some((r) => r.id === id)) return
      const snap = s.segSnapshots[id]
      // Prefer the box the user actually drew (with their tuned parameters);
      // fall back to the region's bounding box for snapshot-less regions.
      const box = snap?.box ?? regionBoundingBox(s.labelMap, vol.dims, id)
      let params = snap?.params ?? s.segParams
      // A saved constraint may point at a since-removed layer or region.
      const c = params.constraint
      if (
        (c.type === 'overlay' && !s.overlays.some((l) => l.id === c.overlayId)) ||
        (c.type === 'region' && !s.regions.some((r) => r.id === c.regionId))
      ) {
        params = { ...params, constraint: { type: 'none' } }
      }
      set({
        activeRegionId: id,
        editRegionId: id,
        segTool: 'box',
        segParams: params,
        segSlabAxis: snap?.slabAxis ?? null
      })
      if (box) {
        const clamped = clampBox(box, vol.dims)
        // setSegBox clamps and schedules the preview.
        get().setSegBox(clamped)
        // Bring the box into view when the crosshair sits outside it (e.g.
        // editing from the region list while looking somewhere else).
        const cross = get().cross
        const outside = cross.some((v, a) => v < clamped.min[a] || v > clamped.max[a])
        if (outside) {
          get().setCross([
            Math.round((clamped.min[0] + clamped.max[0]) / 2),
            Math.round((clamped.min[1] + clamped.max[1]) / 2),
            Math.round((clamped.min[2] + clamped.max[2]) / 2)
          ])
        }
      }
      // Without voxels or a snapshot there is no box — the user draws one.
    },

    toggleMaximized: (view) =>
      set((s) => ({ maximizedView: s.maximizedView === view ? null : view })),

    updateRegion: (id, patch) =>
      // Name/color feed the exported color table and visibility feeds the
      // mask union, so any of these edits makes a prior export stale.
      set((s) => ({
        regions: s.regions.map((r) => (r.id === id ? { ...r, ...patch } : r)),
        segDirty: true,
        // An edit forks history like paint/commit/delete: a surviving redo
        // could resurrect this region from a snapshot predating the change,
        // silently dropping it.
        redoStack: []
      })),

    deleteRegion: (id) => {
      const s = get()
      if (!s.labelMap) return
      const index = s.regions.findIndex((r) => r.id === id)
      if (index === -1) return
      const region = s.regions[index]
      const indices = eraseRegion(s.labelMap, id)
      const regions = s.regions.filter((r) => r.id !== id)
      const entry: HistoryEntry<SegSnapshot> = {
        patch: patchFromErase(indices, id),
        regions: { before: s.regions, after: regions }
      }
      set({
        regions,
        labelMapRev: s.labelMapRev + 1,
        activeRegionId: s.activeRegionId === id ? null : s.activeRegionId,
        editRegionId: s.editRegionId === id ? null : s.editRegionId,
        undoStack: pushEntry(s.undoStack, entry),
        redoStack: [],
        segDirty: true,
        toasts: [
          ...dropUndoToasts(s.toasts),
          {
            id: nextToastId++,
            text: `Deleted "${region.name}"`,
            action: { label: 'Undo', kind: 'undo' }
          }
        ]
      })
      // A constraint pointing at the deleted region would bound the preview
      // to voxels that no longer exist (setSegParams reschedules the preview).
      const c = s.segParams.constraint
      if (c.type === 'region' && c.regionId === id) {
        get().setSegParams({ constraint: { type: 'none' } })
      } else if (s.segBox && c.type === 'region') {
        schedulePreview()
      }
    },

    undo: () => applyHistory('undo'),

    redo: () => applyHistory('redo'),

    markExported: (vol, path) =>
      set((s) => ({
        // A volume swapped in mid-write keeps its own dirty state: this
        // export saved the OLD volume's regions, not the new one's.
        segDirty: s.volume === vol ? false : s.segDirty,
        exportedPaths:
          path !== null && !s.exportedPaths.has(path)
            ? new Set(s.exportedPaths).add(path)
            : s.exportedPaths
      })),

    pushToast: (t) => {
      const id = nextToastId++
      set((s) => ({ toasts: [...s.toasts, { ...t, id }] }))
      return id
    },

    dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  }
})
