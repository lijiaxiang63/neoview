import {
  constraintFromLabelMap,
  constraintFromVolume,
  segmentRegion,
  type AlignedGridSource,
  type Connectivity,
  type SegBox,
  type SegmentResult
} from './segment'

/**
 * The preview-worker protocol and its compute core. The worker caches the
 * transferred grids (volume, constraint overlays, label map) so each compute
 * request carries only parameters; postMessage's FIFO ordering guarantees a
 * request never runs against data older than what the client sent before it.
 * Pure and worker-free so the whole thing is unit-testable.
 */

export type ConstraintSpec =
  { type: 'none' } | { type: 'overlay'; overlayId: number } | { type: 'region'; regionId: number }

export interface ComputeRequest {
  token: number
  box: SegBox
  bounds: SegBox
  params: {
    low: number
    high: number
    connectivity: Connectivity
    minVoxels: number
    /** Infinity survives the structured clone. */
    maxVoxels: number
  }
  frameOffset: number
  /** Shared frame index, for overlay-constraint alignment. */
  frame: number
  constraint: ConstraintSpec
}

export type ToWorker =
  | { type: 'volume'; grid: AlignedGridSource }
  | { type: 'overlay'; id: number; grid: AlignedGridSource }
  | { type: 'dropOverlay'; id: number }
  | { type: 'labelMap'; data: Uint16Array }
  | { type: 'compute'; req: ComputeRequest }

export type FromWorker =
  { type: 'result'; token: number; result: SegmentResult } | { type: 'error'; token: number }

export interface WorkerCache {
  volume: AlignedGridSource | null
  overlays: Map<number, AlignedGridSource>
  labelMap: Uint16Array | null
}

export function emptyCache(): WorkerCache {
  return { volume: null, overlays: new Map(), labelMap: null }
}

/** Fold one client message into the cache (compute handled by the caller).
 * A new volume clears the dependent grids: overlays are dropped with the
 * base in the store, and the label map lives on the base grid. */
export function applyMessage(
  cache: WorkerCache,
  msg: Exclude<ToWorker, { type: 'compute' }>
): void {
  if (msg.type === 'volume') {
    cache.volume = msg.grid
    cache.overlays.clear()
    cache.labelMap = null
  } else if (msg.type === 'overlay') {
    cache.overlays.set(msg.id, msg.grid)
  } else if (msg.type === 'dropOverlay') {
    // A removed layer's buffer must not stay resident (ids are never
    // reused, so nothing can reference it again).
    cache.overlays.delete(msg.id)
  } else {
    cache.labelMap = msg.data
  }
}

/** Run one compute against the cache; null when required data is missing
 * (the client then falls back to the synchronous path). */
export function computeInCache(cache: WorkerCache, req: ComputeRequest): SegmentResult | null {
  const vol = cache.volume
  if (!vol) return null
  let constraint: ReturnType<typeof constraintFromLabelMap> | null = null
  if (req.constraint.type === 'overlay') {
    const grid = cache.overlays.get(req.constraint.overlayId)
    if (!grid) return null
    constraint = constraintFromVolume(vol, grid, req.frame)
    if (!constraint) return null
  } else if (req.constraint.type === 'region') {
    if (!cache.labelMap) return null
    constraint = constraintFromLabelMap(cache.labelMap, vol.dims, req.constraint.regionId)
  }
  return segmentRegion(vol, req.box, req.bounds, req.params, req.frameOffset, constraint)
}
