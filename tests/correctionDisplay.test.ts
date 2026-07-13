import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAppStore } from '../src/renderer/src/store'
import { extractOverlayRGBA } from '../src/renderer/src/slicing/overlay'
import { defaultCorrectionConfig } from '../src/renderer/src/stats/correctionConfig'
import { PLANES } from '../src/renderer/src/slicing/extract'
import type { OverlayLayer } from '../src/renderer/src/slicing/overlay'
import type { Volume } from '../src/renderer/src/volume/types'

function identity(): Float64Array {
  const m = new Float64Array(16)
  m[0] = m[5] = m[10] = m[15] = 1
  return m
}

const N = 8
const at = (i: number, j: number, k: number): number => i + j * N + k * N * N

/** Base grid; contents are irrelevant to the overlay gate. */
function baseVolume(): Volume {
  return zVolume(() => 1, { kind: 'z', dof1: null, dof2: null })
}

/** A z-map: 3³ blob of +5 at [1,4), a 2³ blob of −3 at [6,8), background 0.3. */
function statMap(): Volume {
  return zVolume(
    (i, j, k) => {
      if (i >= 1 && i < 4 && j >= 1 && j < 4 && k >= 1 && k < 4) return 5
      if (i >= 6 && i < 8 && j >= 6 && j < 8 && k >= 6 && k < 8) return -3
      return 0.3
    },
    { kind: 'z', dof1: null, dof2: null }
  )
}

function zVolume(
  value: (i: number, j: number, k: number) => number,
  statistic: Volume['statistic']
): Volume {
  const raw = new Float32Array(N * N * N)
  for (let k = 0; k < N; k++)
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) raw[at(i, j, k)] = value(i, j, k)
  return {
    name: 'stat',
    dims: [N, N, N],
    frames: 1,
    spacing: [1, 1, 1],
    datatypeCode: 16,
    datatypeName: 'float32',
    raw,
    slope: 1,
    inter: 0,
    affine: identity(),
    transformSource: 'spacing-fallback',
    suggestedRange: null,
    labels: null,
    statistic,
    smoothness: null,
    stats: { dataMin: -3, dataMax: 5, p2: -3, p98: 5, typeRange: null }
  }
}

const stub = (w: number, h: number): ImageData =>
  ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }) as unknown as ImageData

function countVisible(img: ImageData): number {
  const px = new Uint32Array(img.data.buffer)
  let n = 0
  for (const v of px) if ((v >>> 24) & 0xff) n++
  return n
}

describe('correction display (store → domain → extractor)', () => {
  let store: ReturnType<typeof createAppStore>

  beforeEach(() => {
    vi.useFakeTimers()
    store = createAppStore({ storage: null, pagehideTarget: null })
    store.getState().setVolume(baseVolume(), '/data/base')
    store.getState().addOverlay(statMap())
  })

  afterEach(() => {
    store.dispose()
    vi.useRealTimers()
  })

  const layer = (): OverlayLayer => store.getState().overlays[0]
  const enable = (patch: Record<string, unknown> = {}): void => {
    const cfg = { ...defaultCorrectionConfig(layer().volume.statistic), ...patch }
    store.getState().updateOverlay(layer().id, { correction: cfg })
    vi.advanceTimersByTime(150)
  }

  it('re-thresholds live for uncorrected then Bonferroni', () => {
    enable() // uncorrected, α=0.05, z, two-tailed
    let sig = layer().significance
    expect(sig?.statThreshold).toBeCloseTo(1.959963984540054, 6)
    expect(sig?.survivingVoxels).toBe(27 + 8) // both blobs clear |z|≥1.96

    store.getState().updateOverlay(layer().id, {
      correction: { ...layer().correction!, method: 'bonferroni', rev: 2 }
    })
    vi.advanceTimersByTime(150)
    sig = layer().significance
    expect(sig?.statThreshold).toBeGreaterThan(3.5) // α/m raises the bar
    expect(sig?.survivingVoxels).toBe(27) // only the +5 blob clears it
  })

  it('the slice raster shows only surviving voxels', () => {
    enable() // uncorrected
    // XY slice at k=2 cuts the +5 blob (i,j ∈ [1,4)) → a 3×3 patch survives.
    const img = stub(N, N)
    extractOverlayRGBA(layer(), layer().volume, PLANES[0], 2, 0, img)
    expect(countVisible(img)).toBe(9)

    // A slice with no supra-threshold voxels is fully transparent.
    const empty = stub(N, N)
    extractOverlayRGBA(layer(), layer().volume, PLANES[0], 5, 0, empty)
    expect(countVisible(empty)).toBe(0)
  })

  it('produces a cluster report of the surviving clusters', () => {
    enable() // uncorrected
    const report = layer().significance?.report
    expect(report?.records).toHaveLength(2)
    // Ordered largest first: the +5 blob (27 vox), then the −3 blob (8 vox).
    expect(report?.records[0].voxelCount).toBe(27)
    expect(report?.records[0].peakStat).toBe(5)
    expect(report?.records[1].voxelCount).toBe(8)
    expect(report?.records[1].peakStat).toBe(-3)
  })

  it('disabling correction restores the unthresholded display', () => {
    enable()
    expect(layer().significance).not.toBeNull()
    store.getState().updateOverlay(layer().id, { correction: null })
    expect(layer().significance).toBeNull()
  })

  it('a base replacement clears the layer and its correction work', () => {
    enable()
    store.getState().setVolume(baseVolume(), '/data/base2')
    expect(store.getState().overlays).toHaveLength(0)
  })
})
