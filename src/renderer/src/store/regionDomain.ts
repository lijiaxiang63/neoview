import type { Volume } from '../volume/types'
import type { OverlayLayer } from '../slicing/overlay'
import { slicePlanesForAffine } from '../slicing/directionLabels'
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
} from '../segmentation/segment'
import { PreviewClient } from '../segmentation/previewClient'
import {
  applyMaskAsRegion,
  computeRegionStats,
  defaultRegionColor,
  eraseRegion,
  eraseRegionInto,
  paintStroke,
  regionBoundingBox,
  type Region
} from '../segmentation/regions'
import {
  applyPatchValues,
  BulkChangeCollector,
  ChangeCollector,
  patchFromErase,
  pushEntry,
  type HistoryEntry
} from '../segmentation/history'

export type SegTool = 'crosshair' | 'box' | 'brush'
export type SegMethod = 'threshold' | 'grow'

export type SegConstraint =
  { type: 'none' } | { type: 'overlay'; overlayId: number } | { type: 'region'; regionId: number }

export interface SegParams {
  method: SegMethod
  low: number
  high: number
  connectivity: Connectivity
  minVoxels: number
  growMargin: number | null
  constraint: SegConstraint
}

export interface SegPreview {
  mask: Uint8Array
  bounds: SegBox
  voxels: number
  components: number
  truncated: boolean
  domain: { min: number; max: number; mean: number }
  histogram: HistogramResult
}

export interface ToastState {
  text: string
  variant?: 'info' | 'success' | 'error'
  action?: { label: string; kind: 'undo' } | { label: string; kind: 'reveal'; path: string }
}

export interface ToastItem extends ToastState {
  id: number
}

export interface SegSnapshot {
  box: SegBox
  slabAxis: 0 | 1 | 2 | null
  params: SegParams
}

export interface RegionState {
  labelMap: Uint16Array | null
  labelMapRev: number
  regions: Region[]
  nextRegionId: number
  activeRegionId: number | null
  segTool: SegTool
  segBox: SegBox | null
  editRegionId: number | null
  segSnapshots: Record<number, SegSnapshot>
  maximizedView: 0 | 1 | 2 | null
  segSlabAxis: 0 | 1 | 2 | null
  slabDepth: number
  segParams: SegParams
  preview: SegPreview | null
  brushRadius: number
  regionOpacity: number
  segDirty: boolean
  segRevision: number
  exportedPaths: ReadonlySet<string>
  undoStack: HistoryEntry<SegSnapshot>[]
  redoStack: HistoryEntry<SegSnapshot>[]
  toasts: ToastItem[]
}

export interface RegionActions {
  refreshRegionStats: () => void
  setSegTool: (tool: SegTool) => void
  setSegBox: (box: SegBox | null) => void
  finalizeBox: (box: SegBox, slabAxis: 0 | 1 | 2) => void
  setSlabDepth: (depth: number) => void
  initSegDefaults: () => void
  applyMethod: (method: SegMethod) => void
  autoThreshold: (kind: 'otsu' | 'mean') => void
  setSegParams: (patch: Partial<SegParams>) => void
  commitPreview: () => void
  cancelSeg: () => void
  paintAt: (view: 0 | 1 | 2, from: [number, number], to: [number, number], erase: boolean) => void
  endStroke: () => void
  setBrushRadius: (radius: number) => void
  setRegionOpacity: (opacity: number) => void
  setActiveRegion: (id: number | null) => void
  editRegion: (id: number) => void
  toggleMaximized: (view: 0 | 1 | 2) => void
  updateRegion: (id: number, patch: Partial<Pick<Region, 'name' | 'color' | 'visible'>>) => void
  deleteRegion: (id: number) => void
  undo: () => void
  redo: () => void
  markExported: (volume: Volume, sourcePath: string | null, revision: number) => void
  pushToast: (toast: ToastState) => number
  dismissToast: (id: number) => void
}

export interface PreviewController {
  available(): boolean
  reset(): void
  dropOverlay(id: number): void
  request: PreviewClient['request']
  dispose(): void
}

export interface RegionTimers {
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>
  clearTimeout(handle: ReturnType<typeof setTimeout>): void
}

export interface RegionHostState extends RegionState, RegionActions {
  volume: Volume | null
  frame: number
  overlays: OverlayLayer[]
  cross: [number, number, number]
  setCross(ijk: [number, number, number]): void
}

type RegionSet = (
  patch: Partial<RegionHostState> | ((state: RegionHostState) => Partial<RegionHostState>)
) => void

export interface RegionDomain {
  state: RegionState & RegionActions
  resetForVolume(): Partial<RegionState>
  frameChanged(hadBox: boolean): void
  overlayRemoved(id: number): void
  dispose(): void
}

export const BRUSH_RADIUS_MIN = 1
export const BRUSH_RADIUS_MAX = 30
export const REGION_STATS_DEBOUNCE_MS = 180
export const SLAB_DEPTH_DEFAULT = 9

const HISTOGRAM_BINS = 96
const WORKER_MIN_BOUNDS_VOXELS = 4 * 1024 * 1024

const DEFAULT_SEG_PARAMS: SegParams = {
  method: 'threshold',
  low: THRESHOLD_DEFAULT,
  high: THRESHOLD_DEFAULT,
  connectivity: 26,
  minVoxels: 3,
  growMargin: null,
  constraint: { type: 'none' }
}

const METHOD_DEFAULTS: Record<SegMethod, Partial<SegParams>> = {
  threshold: { minVoxels: 3 },
  grow: { minVoxels: 1, growMargin: null }
}

function defaultSegParams(): SegParams {
  return { ...DEFAULT_SEG_PARAMS, constraint: { type: 'none' } }
}

export function normalizeSegParams(params: SegParams, edited: 'low' | 'high'): SegParams {
  const out = { ...params }
  if (out.growMargin !== null) out.growMargin = Math.max(0, Math.round(out.growMargin))
  out.minVoxels = Math.max(1, Math.round(out.minVoxels))
  if (out.low > out.high) {
    if (edited === 'high') out.low = out.high
    else out.high = out.low
  }
  return out
}

export function floodCap(params: SegParams, boundsVoxels: number, volumeVoxels: number): number {
  return params.method === 'grow' && boundsVoxels >= volumeVoxels ? MAX_RESULT_VOXELS : Infinity
}

function frameOffsetOf(volume: Volume, frame: number): number {
  const voxels = volume.dims[0] * volume.dims[1] * volume.dims[2]
  return Math.min(frame, volume.frames - 1) * voxels
}

const dropUndoToasts = (toasts: ToastItem[]): ToastItem[] =>
  toasts.filter((toast) => toast.action?.kind !== 'undo')

function initialRegionState(): RegionState {
  return {
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
    segParams: defaultSegParams(),
    preview: null,
    brushRadius: 4,
    regionOpacity: 0.5,
    segDirty: false,
    segRevision: 0,
    exportedPaths: new Set<string>(),
    undoStack: [],
    redoStack: [],
    toasts: []
  }
}

export function createRegionDomain(deps: {
  get(): RegionHostState
  set: RegionSet
  timers: RegionTimers
  previewClient?: PreviewController
}): RegionDomain {
  const { get, set, timers } = deps
  const previewClient = deps.previewClient ?? new PreviewClient()
  let disposed = false
  let nextToastId = 0
  let strokeCollector: ChangeCollector | null = null
  let previewTimer: ReturnType<typeof setTimeout> | undefined
  let previewPending = false
  let previewToken = 0
  let regionStatsTimer: ReturnType<typeof setTimeout> | undefined
  let regionStatsPendingAfterStroke = false
  let regionStatsCache: {
    volume: Volume
    labelMap: Uint16Array
    revision: number
    frames: Map<number, Map<number, Pick<Region, 'voxelCount' | 'stats'>>>
  } | null = null

  const clearRegionStatsTimer = (): void => {
    if (regionStatsTimer === undefined) return
    timers.clearTimeout(regionStatsTimer)
    regionStatsTimer = undefined
  }

  const cachedRegionStats = (
    volume: Volume,
    labelMap: Uint16Array,
    revision: number,
    frame: number,
    regions: readonly Region[]
  ): Region[] | null => {
    const cache = regionStatsCache
    if (
      !cache ||
      cache.volume !== volume ||
      cache.labelMap !== labelMap ||
      cache.revision !== revision
    ) {
      return null
    }
    const byId = cache.frames.get(frame)
    if (!byId || regions.some((region) => !byId.has(region.id))) return null
    cache.frames.delete(frame)
    cache.frames.set(frame, byId)
    return regions.map((region) => ({ ...region, ...byId.get(region.id)! }))
  }

  const cacheRegionStats = (
    volume: Volume,
    labelMap: Uint16Array,
    revision: number,
    frame: number,
    regions: readonly Region[]
  ): void => {
    if (
      !regionStatsCache ||
      regionStatsCache.volume !== volume ||
      regionStatsCache.labelMap !== labelMap ||
      regionStatsCache.revision !== revision
    ) {
      regionStatsCache = { volume, labelMap, revision, frames: new Map() }
    }
    const byId = new Map<number, Pick<Region, 'voxelCount' | 'stats'>>()
    for (const region of regions) {
      byId.set(region.id, { voxelCount: region.voxelCount, stats: region.stats })
    }
    regionStatsCache.frames.delete(frame)
    regionStatsCache.frames.set(frame, byId)
    while (regionStatsCache.frames.size > 16) {
      const oldest = regionStatsCache.frames.keys().next().value
      if (oldest === undefined) break
      regionStatsCache.frames.delete(oldest)
    }
  }

  const refreshRegionStatsNow = (): void => {
    clearRegionStatsTimer()
    if (strokeCollector) {
      regionStatsPendingAfterStroke = true
      return
    }
    const state = get()
    if (!state.volume || !state.labelMap || state.regions.length === 0) return
    const cached = cachedRegionStats(
      state.volume,
      state.labelMap,
      state.labelMapRev,
      state.frame,
      state.regions
    )
    if (cached) {
      set({ regions: cached })
      return
    }
    const regions = computeRegionStats(
      state.volume,
      state.labelMap,
      state.regions,
      frameOffsetOf(state.volume, state.frame)
    )
    cacheRegionStats(state.volume, state.labelMap, state.labelMapRev, state.frame, regions)
    set({ regions })
  }

  const scheduleRegionStatsRefresh = (): void => {
    clearRegionStatsTimer()
    if (strokeCollector) {
      regionStatsPendingAfterStroke = true
      return
    }
    const state = get()
    if (!state.volume || !state.labelMap || state.regions.length === 0) return
    regionStatsTimer = timers.setTimeout(() => {
      regionStatsTimer = undefined
      refreshRegionStatsNow()
    }, REGION_STATS_DEBOUNCE_MS)
  }

  const constraintPredicate = (): VoxelPredicate | null => {
    const state = get()
    const volume = state.volume
    if (!volume) return null
    const constraint = state.segParams.constraint
    if (constraint.type === 'overlay') {
      const layer = state.overlays.find((candidate) => candidate.id === constraint.overlayId)
      return layer ? constraintFromVolume(volume, layer.volume, state.frame) : null
    }
    if (constraint.type === 'region' && state.labelMap) {
      return constraintFromLabelMap(state.labelMap, volume.dims, constraint.regionId)
    }
    return null
  }

  const floodBounds = (
    volume: Volume,
    box: SegBox,
    params: SegParams,
    constrained: boolean
  ): SegBox => {
    if (params.method !== 'grow') return box
    return constrained || params.growMargin === null
      ? wholeVolumeBox(volume.dims)
      : clampBox(dilatedBox(box, params.growMargin), volume.dims)
  }

  const engineParams = (
    volume: Volume,
    params: SegParams,
    bounds: SegBox
  ): {
    low: number
    high: number
    connectivity: Connectivity
    minVoxels: number
    maxVoxels: number
  } => ({
    low: params.low,
    high: params.method === 'threshold' ? params.low : params.high,
    connectivity: params.connectivity,
    minVoxels: params.minVoxels,
    maxVoxels: floodCap(
      params,
      boxVoxelCount(bounds),
      volume.dims[0] * volume.dims[1] * volume.dims[2]
    )
  })

  const publishPreview = (
    result: Omit<SegPreview, 'domain' | 'histogram'>,
    domain: SegPreview['domain'],
    histogram: HistogramResult
  ): void => {
    if (!disposed) set({ preview: { ...result, domain, histogram } })
  }

  const computePreviewNow = (): void => {
    previewPending = false
    previewToken++
    if (disposed) return
    const state = get()
    const volume = state.volume
    if (!volume || !state.segBox) {
      if (state.preview) set({ preview: null })
      return
    }
    const box = state.segBox
    const params = state.segParams
    const frameOffset = frameOffsetOf(volume, state.frame)
    const constraint = constraintPredicate()
    const domain = boxStats(volume, box, frameOffset, constraint)
    const bounds = floodBounds(volume, box, params, constraint !== null)
    const result = segmentRegion(
      volume,
      box,
      bounds,
      engineParams(volume, params, bounds),
      frameOffset,
      constraint
    )
    publishPreview(
      result,
      domain,
      boxHistogram(volume, box, HISTOGRAM_BINS, frameOffset, constraint)
    )
  }

  const computePreview = (): void => {
    if (disposed) return
    const state = get()
    const volume = state.volume
    if (!volume || !state.segBox) {
      computePreviewNow()
      return
    }
    const box = state.segBox
    const params = state.segParams
    const constraint = constraintPredicate()
    const bounds = floodBounds(volume, box, params, constraint !== null)
    if (!previewClient.available() || boxVoxelCount(bounds) < WORKER_MIN_BOUNDS_VOXELS) {
      computePreviewNow()
      return
    }
    const frameOffset = frameOffsetOf(volume, state.frame)
    const domain = boxStats(volume, box, frameOffset, constraint)
    const histogram = boxHistogram(volume, box, HISTOGRAM_BINS, frameOffset, constraint)
    const token = ++previewToken
    const posted = previewClient.request(
      volume,
      state.labelMap,
      state.labelMapRev,
      state.overlays,
      {
        token,
        box,
        bounds,
        params: engineParams(volume, params, bounds),
        frameOffset,
        frame: state.frame,
        constraint: params.constraint
      },
      (responseToken, result) => {
        if (disposed) return
        if (responseToken === -1) {
          if (token === previewToken) computePreviewNow()
          return
        }
        if (responseToken !== previewToken) return
        if (!result) {
          computePreviewNow()
          return
        }
        const current = get()
        if (current.volume !== volume || !current.segBox) return
        previewPending = false
        publishPreview(result, domain, histogram)
      }
    )
    if (!posted) computePreviewNow()
  }

  const clearPreviewTimer = (): void => {
    if (previewTimer === undefined) return
    timers.clearTimeout(previewTimer)
    previewTimer = undefined
  }

  const schedulePreview = (): void => {
    if (disposed) return
    previewPending = true
    previewToken++
    clearPreviewTimer()
    previewTimer = timers.setTimeout(() => {
      previewTimer = undefined
      computePreview()
    }, 90)
  }

  const cancelScheduledPreview = (): void => {
    previewPending = false
    previewToken++
    clearPreviewTimer()
  }

  const seedFromBox = (): number => {
    const state = get()
    const volume = state.volume
    if (!volume || !state.segBox) return GROW_SEED_DEFAULT
    const stats = boxStats(
      volume,
      state.segBox,
      frameOffsetOf(volume, state.frame),
      constraintPredicate()
    )
    return stats.count > 0 ? clampTo(stats.mean, GROW_SEED_RANGE) : GROW_SEED_DEFAULT
  }

  const applyHistory = (direction: 'undo' | 'redo'): void => {
    if (strokeCollector) return
    const state = get()
    const volume = state.volume
    const stack = direction === 'undo' ? state.undoStack : state.redoStack
    const entry = stack[stack.length - 1]
    if (!volume || !entry) return
    const labelMap = state.labelMap
    if (entry.patch && labelMap) {
      applyPatchValues(
        labelMap,
        entry.patch.indices,
        direction === 'undo' ? entry.patch.before : entry.patch.after
      )
    }
    const snapshot = entry.regions
      ? entry.regions[direction === 'undo' ? 'before' : 'after']
      : state.regions
    const list = snapshot.map(
      (region) => state.regions.find((current) => current.id === region.id) ?? region
    )
    if (labelMap) clearRegionStatsTimer()
    const regions = labelMap
      ? computeRegionStats(volume, labelMap, list, frameOffsetOf(volume, state.frame))
      : list
    if (labelMap) {
      cacheRegionStats(volume, labelMap, state.labelMapRev + 1, state.frame, regions)
    }
    const stillThere = (id: number | null): boolean =>
      id !== null && regions.some((region) => region.id === id)
    let segSnapshots = state.segSnapshots
    if (entry.snapshot) {
      const snapshotValue = direction === 'undo' ? entry.snapshot.before : entry.snapshot.after
      segSnapshots = { ...state.segSnapshots }
      if (snapshotValue === undefined) delete segSnapshots[entry.snapshot.id]
      else segSnapshots[entry.snapshot.id] = snapshotValue
    }
    set({
      labelMapRev: state.labelMapRev + 1,
      regions,
      segSnapshots,
      nextRegionId: entry.nextId
        ? entry.nextId[direction === 'undo' ? 'before' : 'after']
        : state.nextRegionId,
      undoStack: direction === 'undo' ? state.undoStack.slice(0, -1) : [...state.undoStack, entry],
      redoStack: direction === 'undo' ? [...state.redoStack, entry] : state.redoStack.slice(0, -1),
      activeRegionId: stillThere(state.activeRegionId) ? state.activeRegionId : null,
      editRegionId: stillThere(state.editRegionId) ? state.editRegionId : null,
      segDirty: true,
      segRevision: state.segRevision + 1,
      toasts: dropUndoToasts(state.toasts)
    })
    const constraint = get().segParams.constraint
    if (
      constraint.type === 'region' &&
      !regions.some((region) => region.id === constraint.regionId)
    ) {
      get().setSegParams({ constraint: { type: 'none' } })
    } else if (get().segBox) {
      schedulePreview()
    }
  }

  const actions: RegionActions = {
    refreshRegionStats: refreshRegionStatsNow,
    setSegTool: (tool) => set({ segTool: tool }),
    setSegBox: (box) => {
      const volume = get().volume
      if (!volume) return
      if (!box) {
        cancelScheduledPreview()
        set({ segBox: null, preview: null })
        return
      }
      set({ segBox: clampBox(box, volume.dims) })
      schedulePreview()
    },
    finalizeBox: (box, slabAxis) => {
      const volume = get().volume
      if (!volume) return
      set({ segBox: clampBox(box, volume.dims), segSlabAxis: slabAxis })
      get().initSegDefaults()
    },
    setSlabDepth: (value) => {
      const state = get()
      const depth = Math.max(1, Math.round(value))
      set({ slabDepth: depth })
      if (!state.volume || !state.segBox || state.segSlabAxis === null) return
      const axis = state.segSlabAxis
      const center = Math.round((state.segBox.min[axis] + state.segBox.max[axis]) / 2)
      const half = Math.floor(depth / 2)
      const box: SegBox = { min: [...state.segBox.min], max: [...state.segBox.max] }
      box.min[axis] = center - half
      box.max[axis] = center + half
      get().setSegBox(box)
    },
    initSegDefaults: () => {
      const state = get()
      if (!state.volume || !state.segBox) return
      if (state.segParams.method === 'grow') {
        set({
          segParams: normalizeSegParams({ ...state.segParams, high: seedFromBox() }, 'high')
        })
      }
      schedulePreview()
    },
    applyMethod: (method) => {
      const state = get()
      const params = state.segParams
      const low =
        method === 'threshold'
          ? clampTo(params.low, THRESHOLD_RANGE)
          : clampTo(params.low, GROW_BOUNDARY_RANGE)
      const high = method === 'threshold' ? low : seedFromBox()
      set({
        segParams: normalizeSegParams(
          { ...params, ...METHOD_DEFAULTS[method], low, high, method },
          'high'
        )
      })
      if (get().segBox) schedulePreview()
    },
    autoThreshold: (kind) => {
      const state = get()
      const volume = state.volume
      if (!volume || !state.segBox) return
      const frameOffset = frameOffsetOf(volume, state.frame)
      const constraint = constraintPredicate()
      if (state.segParams.method === 'threshold') {
        const stats = boxStats(volume, state.segBox, frameOffset, constraint)
        const value =
          kind === 'otsu'
            ? otsuThreshold(volume, state.segBox, frameOffset, constraint)
            : stats.count > 0
              ? stats.mean
              : AUTO_THRESHOLD_FALLBACK
        const threshold = clampTo(value, THRESHOLD_RANGE)
        get().setSegParams({ low: threshold, high: threshold })
      } else if (kind === 'otsu') {
        const value = otsuThreshold(volume, state.segBox, frameOffset, constraint)
        get().setSegParams({ low: clampTo(value, GROW_BOUNDARY_RANGE) })
      } else {
        get().setSegParams({ high: seedFromBox() })
      }
    },
    setSegParams: (patch) => {
      const edited = patch.high !== undefined && patch.low === undefined ? 'high' : 'low'
      set((state) => ({
        segParams: normalizeSegParams({ ...state.segParams, ...patch }, edited)
      }))
      if (get().segBox) schedulePreview()
    },
    commitPreview: () => {
      if (strokeCollector) return
      if (previewPending) computePreviewNow()
      const state = get()
      const volume = state.volume
      if (!volume || !state.preview || state.preview.voxels === 0) return
      const voxelCount = volume.dims[0] * volume.dims[1] * volume.dims[2]
      const labelMap = state.labelMap ?? new Uint16Array(voxelCount)
      const editingRegion =
        state.editRegionId === null
          ? undefined
          : state.regions.find((region) => region.id === state.editRegionId)
      const editing = editingRegion !== undefined
      const id = editing ? (state.editRegionId as number) : state.nextRegionId
      const changes = new BulkChangeCollector(
        labelMap.length,
        state.preview.voxels + (editingRegion?.voxelCount ?? 0),
        editing
      )
      if (editing) eraseRegionInto(labelMap, id, changes)
      applyMaskAsRegion(
        labelMap,
        volume.dims,
        state.preview.bounds,
        state.preview.mask,
        id,
        changes
      )
      const list = editing
        ? state.regions
        : [
            ...state.regions,
            {
              id,
              name: `Region ${id}`,
              color: defaultRegionColor(id),
              visible: true,
              voxelCount: 0,
              stats: null
            } satisfies Region
          ]
      clearRegionStatsTimer()
      const regions = computeRegionStats(volume, labelMap, list, frameOffsetOf(volume, state.frame))
      cacheRegionStats(volume, labelMap, state.labelMapRev + 1, state.frame, regions)
      const snapshot: SegSnapshot | null = state.segBox
        ? { box: state.segBox, slabAxis: state.segSlabAxis, params: state.segParams }
        : null
      const entry: HistoryEntry<SegSnapshot> = {
        patch: changes.finish(labelMap),
        regions: { before: state.regions, after: regions },
        nextId: {
          before: state.nextRegionId,
          after: editing ? state.nextRegionId : id + 1
        },
        ...(snapshot
          ? {
              snapshot: {
                id,
                before: state.segSnapshots[id],
                after: snapshot
              }
            }
          : {})
      }
      const segSnapshots = snapshot ? { ...state.segSnapshots, [id]: snapshot } : state.segSnapshots
      cancelScheduledPreview()
      set({
        labelMap,
        labelMapRev: state.labelMapRev + 1,
        regions,
        segSnapshots,
        nextRegionId: editing ? state.nextRegionId : id + 1,
        activeRegionId: id,
        segBox: null,
        segSlabAxis: null,
        preview: null,
        editRegionId: null,
        segTool: 'crosshair',
        segDirty: true,
        segRevision: state.segRevision + 1,
        undoStack: pushEntry(state.undoStack, entry),
        redoStack: [],
        toasts: dropUndoToasts(state.toasts)
      })
    },
    cancelSeg: () => {
      cancelScheduledPreview()
      set({ segBox: null, segSlabAxis: null, preview: null, editRegionId: null })
    },
    paintAt: (view, from, to, erase) => {
      const state = get()
      const volume = state.volume
      if (!volume || !state.labelMap || state.activeRegionId === null) return
      const plane = slicePlanesForAffine(volume.affine)[view]
      if (!strokeCollector) strokeCollector = new ChangeCollector()
      const changed = paintStroke(
        state.labelMap,
        volume.dims,
        plane,
        state.cross[plane.sliceAxis],
        from,
        to,
        state.brushRadius,
        state.activeRegionId,
        erase,
        strokeCollector
      )
      if (changed === 0) return
      clearRegionStatsTimer()
      set({
        labelMapRev: state.labelMapRev + 1,
        segDirty: true,
        segRevision: state.segRevision + 1
      })
    },
    endStroke: () => {
      const state = get()
      const volume = state.volume
      const patch =
        state.labelMap && strokeCollector ? strokeCollector.finish(state.labelMap) : null
      strokeCollector = null
      const refreshAfterStroke = regionStatsPendingAfterStroke
      regionStatsPendingAfterStroke = false
      if (!volume || !state.labelMap) return
      if (!patch) {
        if (refreshAfterStroke) refreshRegionStatsNow()
        return
      }
      if (state.regions.length === 0) {
        applyPatchValues(state.labelMap, patch.indices, patch.before)
        set({ labelMapRev: state.labelMapRev + 1 })
        return
      }
      clearRegionStatsTimer()
      const regions = computeRegionStats(
        volume,
        state.labelMap,
        state.regions,
        frameOffsetOf(volume, state.frame)
      )
      cacheRegionStats(volume, state.labelMap, state.labelMapRev, state.frame, regions)
      set({
        regions,
        undoStack: pushEntry(state.undoStack, { patch }),
        redoStack: [],
        toasts: dropUndoToasts(state.toasts)
      })
      if (state.segBox && state.segParams.constraint.type === 'region') schedulePreview()
    },
    setBrushRadius: (radius) =>
      set({
        brushRadius: Math.min(BRUSH_RADIUS_MAX, Math.max(BRUSH_RADIUS_MIN, Math.round(radius)))
      }),
    setRegionOpacity: (opacity) => set({ regionOpacity: Math.min(1, Math.max(0, opacity)) }),
    setActiveRegion: (id) => set({ activeRegionId: id }),
    editRegion: (id) => {
      const state = get()
      const volume = state.volume
      if (!volume || !state.labelMap || !state.regions.some((region) => region.id === id)) return
      const snapshot = state.segSnapshots[id]
      const box = snapshot?.box ?? regionBoundingBox(state.labelMap, volume.dims, id)
      let params = snapshot?.params ?? state.segParams
      const constraint = params.constraint
      if (
        (constraint.type === 'overlay' &&
          !state.overlays.some((layer) => layer.id === constraint.overlayId)) ||
        (constraint.type === 'region' &&
          !state.regions.some((region) => region.id === constraint.regionId))
      ) {
        params = { ...params, constraint: { type: 'none' } }
      }
      set({
        activeRegionId: id,
        editRegionId: id,
        segTool: 'box',
        segParams: params,
        segSlabAxis: snapshot?.slabAxis ?? null
      })
      if (!box) return
      const clamped = clampBox(box, volume.dims)
      get().setSegBox(clamped)
      const cross = get().cross
      const outside = cross.some(
        (value, axis) => value < clamped.min[axis] || value > clamped.max[axis]
      )
      if (outside) {
        get().setCross([
          Math.round((clamped.min[0] + clamped.max[0]) / 2),
          Math.round((clamped.min[1] + clamped.max[1]) / 2),
          Math.round((clamped.min[2] + clamped.max[2]) / 2)
        ])
      }
    },
    toggleMaximized: (view) =>
      set((state) => ({ maximizedView: state.maximizedView === view ? null : view })),
    updateRegion: (id, patch) =>
      set((state) => {
        const patchList = (list: Region[]): Region[] =>
          list.some((region) => region.id === id)
            ? list.map((region) => (region.id === id ? { ...region, ...patch } : region))
            : list
        const patchEntry = (entry: HistoryEntry<SegSnapshot>): HistoryEntry<SegSnapshot> =>
          entry.regions
            ? {
                ...entry,
                regions: {
                  before: patchList(entry.regions.before),
                  after: patchList(entry.regions.after)
                }
              }
            : entry
        return {
          regions: patchList(state.regions),
          segDirty: true,
          segRevision: state.segRevision + 1,
          undoStack: state.undoStack.map(patchEntry),
          redoStack: []
        }
      }),
    deleteRegion: (id) => {
      if (strokeCollector) return
      const state = get()
      if (!state.labelMap) return
      const index = state.regions.findIndex((region) => region.id === id)
      if (index === -1) return
      const region = state.regions[index]
      const indices = eraseRegion(state.labelMap, id)
      const regions = state.regions.filter((candidate) => candidate.id !== id)
      const entry: HistoryEntry<SegSnapshot> = {
        patch: patchFromErase(indices, id),
        regions: { before: state.regions, after: regions }
      }
      set({
        regions,
        labelMapRev: state.labelMapRev + 1,
        activeRegionId: state.activeRegionId === id ? null : state.activeRegionId,
        editRegionId: state.editRegionId === id ? null : state.editRegionId,
        undoStack: pushEntry(state.undoStack, entry),
        redoStack: [],
        segDirty: true,
        segRevision: state.segRevision + 1,
        toasts: [
          ...dropUndoToasts(state.toasts),
          {
            id: nextToastId++,
            text: `Deleted "${region.name}"`,
            action: { label: 'Undo', kind: 'undo' }
          }
        ]
      })
      const constraint = state.segParams.constraint
      if (constraint.type === 'region' && constraint.regionId === id) {
        get().setSegParams({ constraint: { type: 'none' } })
      } else if (state.segBox && constraint.type === 'region') {
        schedulePreview()
      }
    },
    undo: () => applyHistory('undo'),
    redo: () => applyHistory('redo'),
    markExported: (volume, path, revision) =>
      set((state) => ({
        segDirty:
          state.volume === volume && state.segRevision === revision ? false : state.segDirty,
        exportedPaths:
          path !== null && !state.exportedPaths.has(path)
            ? new Set(state.exportedPaths).add(path)
            : state.exportedPaths
      })),
    pushToast: (toast) => {
      const id = nextToastId++
      set((state) => ({ toasts: [...state.toasts, { ...toast, id }] }))
      return id
    },
    dismissToast: (id) =>
      set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }))
  }

  return {
    state: { ...initialRegionState(), ...actions },
    resetForVolume: () => {
      cancelScheduledPreview()
      clearRegionStatsTimer()
      regionStatsCache = null
      strokeCollector = null
      regionStatsPendingAfterStroke = false
      if (!disposed) previewClient.reset()
      return {
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
        segParams: defaultSegParams(),
        segDirty: false,
        segRevision: 0,
        undoStack: [],
        redoStack: [],
        toasts: []
      }
    },
    frameChanged: (hadBox) => {
      scheduleRegionStatsRefresh()
      if (hadBox) schedulePreview()
    },
    overlayRemoved: (id) => {
      if (!disposed) previewClient.dropOverlay(id)
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      clearRegionStatsTimer()
      regionStatsCache = null
      clearPreviewTimer()
      previewPending = false
      previewToken++
      strokeCollector = null
      regionStatsPendingAfterStroke = false
      previewClient.dispose()
    }
  }
}
