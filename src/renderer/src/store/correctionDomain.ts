// Renderer-side domain that owns multiple-comparison correction for stat-map
// overlay layers: it debounces recomputes, extracts a frame's values, runs the
// correction (off-thread when a worker is available, synchronously otherwise),
// and writes the resolved significance back onto the layer. Heavy buffers (the
// frame value array, the survival mask) stay here, out of serializable state.

import type { OverlayLayer } from '../slicing/overlay'
import { annotateReport, reannotateReport, type Atlas } from '../stats/atlasAnnotation'
import {
  computeCorrection,
  type CorrectionRequest,
  type CorrectionResult
} from '../stats/correctionCore'
import type { SignificanceResult } from '../stats/correctionConfig'
import type { CorrectionController } from '../stats/correctionRunner'
import type { AtlasProvider } from '../runtime/atlasProvider'
import { composeVoxelMap } from '../volume/affine'
import type { Volume } from '../volume/types'
import type { RegionTimers } from './regionDomain'

const RECOMPUTE_DEBOUNCE_MS = 120

export interface CorrectionHostState {
  overlays: OverlayLayer[]
  frame: number
  volumeSession: number
  /** Selected atlas id for cluster-report region annotation, or null. */
  correctionAtlas: string | null
}

type CorrectionSet = (
  patch:
    Partial<CorrectionHostState> | ((state: CorrectionHostState) => Partial<CorrectionHostState>)
) => void

export interface CorrectionDomain {
  configChanged(id: number): void
  frameChanged(): void
  overlayRemoved(id: number): void
  /** The selected annotation atlas changed; re-annotate existing reports. */
  atlasChanged(): void
  resetForVolume(): void
  dispose(): void
}

export function createCorrectionDomain(deps: {
  get(): CorrectionHostState
  set: CorrectionSet
  timers: RegionTimers
  runner?: CorrectionController
  atlasProvider?: AtlasProvider | null
}): CorrectionDomain {
  const { get, set, timers, runner } = deps
  const atlasProvider = deps.atlasProvider ?? null
  let disposed = false
  let recomputeTimer: ReturnType<typeof setTimeout> | undefined
  let running = false
  let runningId: number | null = null
  let nextToken = 0
  const pending = new Set<number>()
  // Cached scaled values for the active (volume, frame); rebuilt on change.
  let frameValues: { volume: Volume; frame: number; values: Float64Array } | null = null
  // One-slot cache of a restriction mask sampled onto a stat grid, keyed by the
  // (stat volume, mask volume) pair; rebuilt when either identity changes.
  let restrictCache: { statVol: Volume; maskVol: Volume; mask: Uint8Array } | null = null

  function patchSignificance(id: number, significance: SignificanceResult | null): void {
    set((state) => ({
      overlays: state.overlays.map((layer) =>
        layer.id === id ? { ...layer, significance } : layer
      )
    }))
  }

  /** Mark a layer's existing significance stale so the panel shows "computing…"
   * while a recompute is queued/in flight. */
  function markStale(id: number): void {
    const layer = get().overlays.find((l) => l.id === id)
    if (layer?.significance && !layer.significance.stale) {
      patchSignificance(id, { ...layer.significance, stale: true })
    }
  }

  /** A dispatched result is still wanted only if the layer, its config revision,
   * the frame, and the base volume session are all unchanged. */
  function stillCurrent(id: number, rev: number, frame: number, volumeSession: number): boolean {
    const state = get()
    if (state.frame !== frame || state.volumeSession !== volumeSession) return false
    const layer = state.overlays.find((l) => l.id === id)
    return !!layer && !!layer.correction && layer.correction.rev === rev
  }

  /** Stop wasting a worker on a layer that was removed or had correction turned
   * off, so the next queued layer isn't blocked behind pointless work. */
  function abortIfRunning(id: number): void {
    if (runningId === id) {
      runner?.cancel()
      running = false
      runningId = null
      pump()
    }
  }

  function valuesFor(volume: Volume, frame: number): Float64Array {
    if (frameValues && frameValues.volume === volume && frameValues.frame === frame) {
      return frameValues.values
    }
    const [nx, ny, nz] = volume.dims
    const nVox = nx * ny * nz
    const off = Math.min(frame, volume.frames - 1) * nVox
    const { raw, slope, inter } = volume
    const values = new Float64Array(nVox)
    for (let i = 0; i < nVox; i++) values[i] = raw[off + i] * slope + inter
    frameValues = { volume, frame, values }
    return values
  }

  /** Sample another layer's frame-0 volume onto the stat grid: 1 where the mask
   * is finite and non-zero, else 0. Walks the mapped coordinate incrementally
   * (3 adds per voxel), matching the overlay extractor. */
  function buildRestrictMask(statVol: Volume, maskVol: Volume): Uint8Array {
    const [nx, ny, nz] = statVol.dims
    const out = new Uint8Array(nx * ny * nz)
    const map = composeVoxelMap(statVol.affine, maskVol.affine) // stat voxel → mask voxel
    if (!map) return out.fill(1) // unusable mapping → don't restrict
    const [mx, my, mz] = maskVol.dims
    const { raw, slope, inter } = maskVol
    let idx = 0
    for (let k = 0; k < nz; k++) {
      const bx = map[3] + k * map[2]
      const by = map[7] + k * map[6]
      const bz = map[11] + k * map[10]
      for (let j = 0; j < ny; j++) {
        let x = bx + j * map[1]
        let y = by + j * map[5]
        let z = bz + j * map[9]
        for (let i = 0; i < nx; i++, idx++, x += map[0], y += map[4], z += map[8]) {
          const xi = Math.round(x)
          const yi = Math.round(y)
          const zi = Math.round(z)
          if (xi < 0 || xi >= mx || yi < 0 || yi >= my || zi < 0 || zi >= mz) continue
          const v = raw[xi + yi * mx + zi * mx * my] * slope + inter
          if (Number.isFinite(v) && v !== 0) out[idx] = 1
        }
      }
    }
    return out
  }

  /** The restriction mask (on the layer's own grid) for a corrected layer, or
   * null when it selects no mask or the mask layer is gone. Cached per pair. */
  function restrictFor(layer: OverlayLayer): Uint8Array | null {
    const cfg = layer.correction
    if (!cfg || cfg.maskLayerId == null) return null
    const maskLayer = get().overlays.find((l) => l.id === cfg.maskLayerId && l.id !== layer.id)
    if (!maskLayer) return null
    const statVol = layer.volume
    const maskVol = maskLayer.volume
    if (restrictCache && restrictCache.statVol === statVol && restrictCache.maskVol === maskVol) {
      return restrictCache.mask
    }
    const mask = buildRestrictMask(statVol, maskVol)
    restrictCache = { statVol, maskVol, mask }
    return mask
  }

  function significanceOf(
    result: CorrectionResult,
    layer: OverlayLayer,
    frame: number
  ): SignificanceResult {
    const cfg = layer.correction!
    // Annotate the fresh report with the selected atlas on the main thread (the
    // records are freshly built here, so annotating in place is safe). An atlas
    // change later re-annotates from the retained membership — never recomputes.
    const atlas = currentAtlas()
    if (result.report && atlas) {
      annotateReport(result.report, result.membership, layer.volume.affine, atlas)
    }
    return {
      statThreshold: result.statThreshold,
      minClusterSize: result.minClusterSize,
      mask: result.mask,
      kind: cfg.statistic.kind,
      tail: cfg.tail,
      survivingVoxels: result.survivingVoxels,
      smoothness: result.smoothness,
      report: result.report,
      membership: result.membership,
      configRev: cfg.rev,
      frame,
      stale: false
    }
  }

  /** The already-loaded annotation atlas, or null. Region annotation runs on the
   * main thread from the report's retained membership, so an atlas change only
   * re-annotates (never re-runs correction). */
  function currentAtlas(): Atlas | null {
    const name = get().correctionAtlas
    return name && atlasProvider ? atlasProvider.getCached(name) : null
  }

  /** Process one queued layer, then continue with the next when it settles. */
  function pump(): void {
    if (disposed || running || pending.size === 0) return
    const id = pending.values().next().value as number
    pending.delete(id)
    const state = get()
    const layer = state.overlays.find((l) => l.id === id)
    if (!layer || layer.kind !== 'map' || !layer.correction) {
      if (layer && layer.significance) patchSignificance(id, null)
      pump()
      return
    }
    const cfg = layer.correction
    const frame = state.frame
    const volumeSession = state.volumeSession
    const request: CorrectionRequest = {
      values: valuesFor(layer.volume, frame),
      dims: layer.volume.dims,
      affine: layer.volume.affine,
      spacing: layer.volume.spacing,
      statistic: cfg.statistic,
      method: cfg.method,
      alpha: cfg.alpha,
      clusterFormingP: cfg.clusterFormingP,
      tail: cfg.tail,
      connectivity: cfg.connectivity,
      smoothnessOverride: layer.volume.smoothness ?? undefined,
      restrict: restrictFor(layer),
      includeReport: true
    }

    // Only write a result that still matches the layer, its config revision, the
    // frame, and the base volume; anything else has been superseded.
    const write = (result: CorrectionResult): void => {
      if (disposed || !stillCurrent(id, cfg.rev, frame, volumeSession)) return
      const cur = get().overlays.find((l) => l.id === id)!
      patchSignificance(id, significanceOf(result, cur, frame))
    }

    if (runner) {
      const started = runner.run(nextToken++, volumeSession, id, request, {
        complete: (result) => {
          running = false
          runningId = null
          write(result)
          pump()
        },
        error: () => {
          running = false
          runningId = null
          // Surface the failure by clearing the (now stale) significance, mirroring
          // the synchronous fallback.
          if (stillCurrent(id, cfg.rev, frame, volumeSession)) patchSignificance(id, null)
          pump()
        }
      })
      if (started) {
        running = true
        runningId = id
        return
      }
    }
    // No worker available: compute synchronously.
    try {
      write(computeCorrection(request))
    } catch {
      if (stillCurrent(id, cfg.rev, frame, volumeSession)) patchSignificance(id, null)
    }
    pump()
  }

  function clearTimer(): void {
    if (recomputeTimer !== undefined) {
      timers.clearTimeout(recomputeTimer)
      recomputeTimer = undefined
    }
  }

  function scheduleRecompute(): void {
    clearTimer()
    recomputeTimer = timers.setTimeout(() => {
      recomputeTimer = undefined
      pump()
    }, RECOMPUTE_DEBOUNCE_MS)
  }

  return {
    configChanged(id) {
      if (disposed) return
      const layer = get().overlays.find((l) => l.id === id)
      if (!layer || layer.kind !== 'map' || !layer.correction) {
        if (layer && layer.significance) patchSignificance(id, null)
        pending.delete(id)
        abortIfRunning(id)
        return
      }
      markStale(id)
      pending.add(id)
      scheduleRecompute()
    },
    frameChanged() {
      if (disposed) return
      for (const layer of get().overlays) {
        if (layer.kind === 'map' && layer.correction) {
          markStale(layer.id)
          pending.add(layer.id)
        }
      }
      if (pending.size > 0) scheduleRecompute()
    },
    overlayRemoved(id) {
      pending.delete(id)
      abortIfRunning(id)
      // A corrected layer using the removed layer as its restriction mask must
      // recompute unrestricted; clear the now-dangling reference and its cache.
      const affected = get().overlays.filter(
        (l) => l.kind === 'map' && l.correction && l.correction.maskLayerId === id
      )
      if (affected.length === 0) return
      restrictCache = null
      set((state) => ({
        overlays: state.overlays.map((l) =>
          l.correction && l.correction.maskLayerId === id
            ? {
                ...l,
                correction: { ...l.correction, maskLayerId: null, rev: l.correction.rev + 1 }
              }
            : l
        )
      }))
      for (const l of affected) {
        markStale(l.id)
        pending.add(l.id)
      }
      scheduleRecompute()
    },
    atlasChanged() {
      if (disposed) return
      // Re-annotate every corrected layer's existing report against the new atlas
      // from its retained membership — no correction is re-run. Produces fresh
      // report objects so the cluster table and CSV pick up the change.
      const name = get().correctionAtlas
      const reannotate = (): void => {
        // Bail if the selection moved on while the atlas loaded: a newer
        // atlasChanged for the now-current atlas owns the write. Without this, a
        // slow load (A) resolving after a faster switch (B/None) would stamp the
        // wrong atlas's region names onto the report — and its CSV export.
        if (disposed || get().correctionAtlas !== name) return
        const atlas = name && atlasProvider ? atlasProvider.getCached(name) : null
        for (const layer of get().overlays) {
          const sig = layer.significance
          if (layer.kind !== 'map' || !layer.correction || !sig?.report) continue
          const report = reannotateReport(sig.report, sig.membership, layer.volume.affine, atlas)
          patchSignificance(layer.id, { ...sig, report })
        }
      }
      // Load the atlas first (a no-op when already cached) so getCached hits.
      if (name && atlasProvider) void atlasProvider.get(name).then(reannotate)
      else reannotate()
    },
    resetForVolume() {
      pending.clear()
      clearTimer()
      runner?.cancel()
      running = false
      runningId = null
      frameValues = null
      restrictCache = null
    },
    dispose() {
      disposed = true
      pending.clear()
      clearTimer()
      runner?.dispose()
      running = false
      runningId = null
      frameValues = null
      restrictCache = null
    }
  }
}
