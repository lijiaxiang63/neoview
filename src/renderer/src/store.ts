import { create } from 'zustand'
import type { Volume } from './volume/types'
import { defaultLayerSettings, guessOverlayKind, type OverlayLayer } from './slicing/overlay'
import { PLANES } from './slicing/extract'
import {
  AUTO_THRESHOLD_FALLBACK,
  boxHistogram,
  boxStats,
  clampBox,
  clampTo,
  constraintFromLabelMap,
  constraintFromVolume,
  dilatedBox,
  GROW_BOUNDARY_RANGE,
  GROW_SEED_DEFAULT,
  GROW_SEED_RANGE,
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
import {
  applyMaskAsRegion,
  computeRegionStats,
  defaultRegionColor,
  eraseRegion,
  paintStroke,
  regionBoundingBox,
  restoreRegion,
  type Region
} from './segmentation/regions'

export type Preset = 'auto' | 'full' | 'fixed-0-80' | 'suggested' | 'custom'

export type RenderMode = 'mip' | 'composite'

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
  action?: { label: string; kind: 'undo-delete' } | { label: string; kind: 'reveal'; path: string }
}

interface UndoDelete {
  region: Region
  /** Position in the regions list, so undo restores the original order. */
  index: number
  indices: Uint32Array
}

/** What a commit was made from, so re-editing restores the drawn box and the
 * tuned parameters instead of starting over. */
interface SegSnapshot {
  box: SegBox
  slabAxis: 0 | 1 | 2 | null
  params: SegParams
}

interface AppState {
  volume: Volume | null
  /** Absolute path of the opened base file (null for unknown origins). */
  sourcePath: string | null
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
  undoDelete: UndoDelete | null
  toast: ToastState | null

  startLoading: () => void
  setVolume: (v: Volume, sourcePath?: string | null) => void
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
  undoDeleteRegion: () => void
  markExported: () => void
  setToast: (t: ToastState | null) => void
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

/** Unsaved region edits exist (drives the replace/close confirmation). */
export function hasUnsavedRegions(): boolean {
  const s = useStore.getState()
  return s.segDirty && s.regions.length > 0
}

// Never reset: layer ids must stay unique across base changes for React keys.
let nextOverlayId = 1

// Preview recomputes are debounced so box drags and slider scrubs stay fluid;
// the box-sized compute happens at most once per delay window.
let previewTimer: ReturnType<typeof setTimeout> | undefined

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
      return layer ? constraintFromVolume(vol, layer.volume) : null
    }
    if (c.type === 'region' && s.labelMap) {
      return constraintFromLabelMap(s.labelMap, vol.dims, c.regionId)
    }
    return null
  }

  function computePreviewNow(): void {
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

    // Where the flood may expand: the box itself for thresholding; for grow,
    // the whole volume when a constraint bounds it (or the reach is
    // unlimited), else the box dilated by the margin.
    let bounds: SegBox
    if (p.method === 'grow') {
      bounds =
        constraint || p.growMargin === null
          ? wholeVolumeBox(vol.dims)
          : clampBox(dilatedBox(box, p.growMargin), vol.dims)
    } else {
      bounds = box
    }

    const result = segmentRegion(
      vol,
      box,
      bounds,
      {
        low: p.method === 'threshold' ? p.low : Math.min(p.low, p.high),
        high: p.method === 'threshold' ? p.low : Math.max(p.low, p.high),
        connectivity: p.connectivity,
        minVoxels: p.minVoxels
      },
      frameOffset,
      constraint
    )
    set({
      preview: {
        mask: result.mask,
        bounds: result.bounds,
        voxels: result.voxels,
        components: result.components,
        truncated: result.truncated,
        domain,
        histogram: boxHistogram(vol, box, HISTOGRAM_BINS, frameOffset, constraint)
      }
    })
  }

  function schedulePreview(): void {
    clearTimeout(previewTimer)
    previewTimer = setTimeout(computePreviewNow, 90)
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
    undoDelete: null,
    toast: null,

    startLoading: () => set({ loadState: 'loading', errorMessage: null }),

    setVolume: (v, sourcePath = null) => {
      clearTimeout(previewTimer)
      const preset = pickInitialPreset(v)
      set({
        volume: v,
        sourcePath,
        loadState: 'ready',
        errorMessage: null,
        cross: [Math.floor(v.dims[0] / 2), Math.floor(v.dims[1] / 2), Math.floor(v.dims[2] / 2)],
        frame: 0,
        range: presetRange(v, preset),
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
        undoDelete: null,
        toast: null
      })
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
      const vol = get().volume
      if (!vol) return
      set({ frame: Math.min(Math.max(t, 0), vol.frames - 1) })
      if (get().segBox) schedulePreview()
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

    setBrightness: (b) =>
      set({ brightness: Math.min(BRIGHTNESS_MAX, Math.max(BRIGHTNESS_MIN, b)) }),

    // ---- Region segmentation ------------------------------------------------

    setSegTool: (t) => set({ segTool: t }),

    setSegBox: (box) => {
      const vol = get().volume
      if (!vol) return
      if (!box) {
        clearTimeout(previewTimer)
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
        set({ segParams: { ...s.segParams, high: seedFromBox() } })
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
      set({ segParams: { ...p, ...METHOD_DEFAULTS[m], low, high, method: m } })
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
      set((s) => ({ segParams: { ...s.segParams, ...patch } }))
      if (get().segBox) schedulePreview()
    },

    commitPreview: () => {
      const s = get()
      const vol = s.volume
      if (!vol || !s.preview || s.preview.voxels === 0) return
      const n = vol.dims[0] * vol.dims[1] * vol.dims[2]
      const labelMap = s.labelMap ?? new Uint16Array(n)
      // Re-edit flow: the commit replaces the target region's voxels and
      // keeps its identity (name/color/visibility).
      const editing = s.editRegionId !== null && s.regions.some((r) => r.id === s.editRegionId)
      const id = editing ? (s.editRegionId as number) : s.nextRegionId
      if (editing) eraseRegion(labelMap, id)
      applyMaskAsRegion(labelMap, vol.dims, s.preview.bounds, s.preview.mask, id)
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
      // drawn box and tuned parameters.
      const segSnapshots = s.segBox
        ? {
            ...s.segSnapshots,
            [id]: { box: s.segBox, slabAxis: s.segSlabAxis, params: s.segParams }
          }
        : s.segSnapshots
      // The box is consumed by the commit; the tool drops back to navigation.
      clearTimeout(previewTimer)
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
        segDirty: true
      })
    },

    cancelSeg: () => {
      clearTimeout(previewTimer)
      set({ segBox: null, segSlabAxis: null, preview: null, editRegionId: null })
    },

    paintAt: (view, from, to, erase) => {
      const s = get()
      const vol = s.volume
      if (!vol || !s.labelMap || s.activeRegionId === null) return
      const plane = PLANES[view]
      paintStroke(
        s.labelMap,
        vol.dims,
        plane,
        s.cross[plane.sliceAxis],
        from,
        to,
        s.brushRadius,
        s.activeRegionId,
        erase
      )
      set({ labelMapRev: s.labelMapRev + 1, segDirty: true })
    },

    endStroke: () => {
      const s = get()
      const vol = s.volume
      if (!vol || !s.labelMap || s.regions.length === 0) return
      set({
        regions: computeRegionStats(vol, s.labelMap, s.regions, frameOffsetOf(vol, s.frame))
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
      set((s) => ({
        regions: s.regions.map((r) => (r.id === id ? { ...r, ...patch } : r))
      })),

    deleteRegion: (id) => {
      const s = get()
      if (!s.labelMap) return
      const index = s.regions.findIndex((r) => r.id === id)
      if (index === -1) return
      const region = s.regions[index]
      const indices = eraseRegion(s.labelMap, id)
      set({
        regions: s.regions.filter((r) => r.id !== id),
        labelMapRev: s.labelMapRev + 1,
        activeRegionId: s.activeRegionId === id ? null : s.activeRegionId,
        editRegionId: s.editRegionId === id ? null : s.editRegionId,
        undoDelete: { region, index, indices },
        segDirty: true,
        toast: {
          text: `Deleted "${region.name}"`,
          action: { label: 'Undo', kind: 'undo-delete' }
        }
      })
      if (s.segBox && s.segParams.constraint.type === 'region') schedulePreview()
    },

    undoDeleteRegion: () => {
      const s = get()
      const vol = s.volume
      if (!vol || !s.labelMap || !s.undoDelete) return
      const { region, index, indices } = s.undoDelete
      restoreRegion(s.labelMap, indices, region.id)
      const regions = [...s.regions]
      regions.splice(Math.min(index, regions.length), 0, region)
      set({
        regions: computeRegionStats(vol, s.labelMap, regions, frameOffsetOf(vol, s.frame)),
        labelMapRev: s.labelMapRev + 1,
        undoDelete: null,
        segDirty: true,
        toast: null
      })
    },

    markExported: () => set({ segDirty: false }),

    setToast: (t) => set({ toast: t })
  }
})
