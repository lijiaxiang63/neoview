import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createCorrectionDomain,
  type CorrectionHostState
} from '../src/renderer/src/store/correctionDomain'
import type { OverlayLayer } from '../src/renderer/src/slicing/overlay'
import { computeCorrection, type CorrectionRequest } from '../src/renderer/src/stats/correctionCore'
import { defaultCorrectionConfig } from '../src/renderer/src/stats/correctionConfig'
import type { Volume } from '../src/renderer/src/volume/types'

function identity(): Float64Array {
  const m = new Float64Array(16)
  m[0] = m[5] = m[10] = m[15] = 1
  return m
}

/** A z-map with a 4³ blob of z=6 in a background of 0.3. */
function zMap(): Volume {
  const N = 12
  const raw = new Float32Array(N * N * N).fill(0.3)
  const at = (i: number, j: number, k: number): number => i + j * N + k * N * N
  for (let k = 4; k < 8; k++)
    for (let j = 4; j < 8; j++) for (let i = 4; i < 8; i++) raw[at(i, j, k)] = 6
  return {
    name: 'z',
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
    statistic: { kind: 'z', dof1: null, dof2: null },
    smoothness: null,
    stats: { dataMin: 0.3, dataMax: 6, p2: 0.3, p98: 6, typeRange: null }
  }
}

/** A constant-valued volume on the same 12³ grid, usable as a restriction mask. */
function constVolume(value: number): Volume {
  const N = 12
  return { ...zMap(), name: `const-${value}`, raw: new Float32Array(N * N * N).fill(value) }
}

function mapLayer(id: number, volume: Volume): OverlayLayer {
  return {
    id,
    volume,
    kind: 'map',
    visible: true,
    opacity: 0.6,
    range: { lo: 0, hi: 6 },
    colormap: 'signed',
    hiddenLabels: new Set(),
    sourcePath: null,
    labelTable: null,
    labelTableSource: 'automatic',
    matchingTable: null,
    builtInTable: null,
    customTable: null,
    correction: null,
    significance: null
  }
}

describe('createCorrectionDomain', () => {
  let host: CorrectionHostState
  let scheduled: (() => void) | null

  const get = (): CorrectionHostState => host
  const set = (
    patch: Partial<CorrectionHostState> | ((s: CorrectionHostState) => Partial<CorrectionHostState>)
  ): void => {
    Object.assign(host, typeof patch === 'function' ? patch(host) : patch)
  }
  const timers = {
    setTimeout: (cb: () => void) => {
      scheduled = cb
      return 1 as unknown as ReturnType<typeof setTimeout>
    },
    clearTimeout: () => {
      scheduled = null
    }
  }
  const flush = (): void => {
    const cb = scheduled
    scheduled = null
    cb?.()
  }

  beforeEach(() => {
    host = { overlays: [mapLayer(1, zMap())], frame: 0, volumeSession: 1, correctionAtlas: null }
    scheduled = null
  })

  const enable = (id: number): void => {
    host.overlays = host.overlays.map((l) =>
      l.id === id ? { ...l, correction: defaultCorrectionConfig(l.volume.statistic) } : l
    )
  }

  it('computes an uncorrected threshold after the debounce', () => {
    const domain = createCorrectionDomain({ get, set, timers })
    enable(1)
    domain.configChanged(1)
    expect(host.overlays[0].significance).toBeNull() // debounced, not yet
    flush()
    const sig = host.overlays[0].significance
    expect(sig).not.toBeNull()
    expect(sig?.statThreshold).toBeCloseTo(1.959963984540054, 6) // z, α=0.05, two-tailed
    expect(sig?.survivingVoxels).toBe(4 * 4 * 4)
    expect(sig?.mask).toBeNull()
  })

  it('recomputes when the method changes to Bonferroni', () => {
    const domain = createCorrectionDomain({ get, set, timers })
    enable(1)
    host.overlays = host.overlays.map((l) =>
      l.id === 1 ? { ...l, correction: { ...l.correction!, method: 'bonferroni', rev: 1 } } : l
    )
    domain.configChanged(1)
    flush()
    const sig = host.overlays[0].significance
    expect(sig?.statThreshold).toBeGreaterThan(1.96)
    expect(sig?.survivingVoxels).toBe(64)
  })

  it('clears significance when correction is turned off', () => {
    const domain = createCorrectionDomain({ get, set, timers })
    enable(1)
    domain.configChanged(1)
    flush()
    expect(host.overlays[0].significance).not.toBeNull()
    host.overlays = host.overlays.map((l) => (l.id === 1 ? { ...l, correction: null } : l))
    domain.configChanged(1)
    expect(host.overlays[0].significance).toBeNull()
  })

  it('frameChanged reschedules a recompute for corrected map layers', () => {
    const domain = createCorrectionDomain({ get, set, timers })
    enable(1)
    domain.configChanged(1)
    flush()
    scheduled = null
    domain.frameChanged()
    expect(scheduled).not.toBeNull()
  })

  it('dispose makes later callbacks inert', () => {
    const domain = createCorrectionDomain({ get, set, timers })
    enable(1)
    domain.configChanged(1)
    domain.dispose()
    flush() // scheduled was cleared by dispose
    expect(host.overlays[0].significance).toBeNull()
    domain.configChanged(1)
    expect(scheduled).toBeNull()
  })

  it('overlayRemoved drops pending work', () => {
    const domain = createCorrectionDomain({ get, set, timers })
    enable(1)
    domain.configChanged(1)
    domain.overlayRemoved(1)
    host.overlays = []
    flush()
    expect(host.overlays).toHaveLength(0)
  })

  const withMask = (maskValue: number): void => {
    const stat = host.overlays[0]
    host.overlays = [
      {
        ...stat,
        correction: { ...defaultCorrectionConfig(stat.volume.statistic), maskLayerId: 2, rev: 1 }
      },
      mapLayer(2, constVolume(maskValue))
    ]
  }

  it('restricts the correction to the selected mask layer', () => {
    const domain = createCorrectionDomain({ get, set, timers })
    withMask(0) // all-zero mask → the blob is outside it
    domain.configChanged(1)
    flush()
    expect(host.overlays[0].significance?.survivingVoxels).toBe(0)
    expect(host.overlays[0].significance?.mask).not.toBeNull() // gate restricts by mask
  })

  it('a whole-map mask leaves the result unrestricted', () => {
    const domain = createCorrectionDomain({ get, set, timers })
    withMask(1) // all-one mask → same voxels as no restriction
    domain.configChanged(1)
    flush()
    expect(host.overlays[0].significance?.survivingVoxels).toBe(4 * 4 * 4)
  })

  it('clears the mask reference and recomputes when the mask layer is removed', () => {
    const domain = createCorrectionDomain({ get, set, timers })
    withMask(0)
    domain.configChanged(1)
    flush()
    expect(host.overlays[0].significance?.survivingVoxels).toBe(0)
    // The store filters the layer out, then notifies the domain.
    host.overlays = host.overlays.filter((l) => l.id !== 2)
    domain.overlayRemoved(2)
    expect(host.overlays[0].correction?.maskLayerId).toBeNull() // dangling ref cleared
    flush()
    expect(host.overlays[0].significance?.survivingVoxels).toBe(4 * 4 * 4) // unrestricted now
  })

  it('samples the mask through a non-identity (axis-swap) affine', () => {
    const N = 12
    const at = (i: number, j: number, k: number): number => i + j * N + k * N * N
    // Stat map with an asymmetric blob: i∈[2,4), j∈[2,8), k∈[2,8) → i-extent 2, j-extent 6.
    const statRaw = new Float32Array(N * N * N).fill(0.3)
    for (let k = 2; k < 8; k++)
      for (let j = 2; j < 8; j++) for (let i = 2; i < 4; i++) statRaw[at(i, j, k)] = 6
    const statVol: Volume = { ...zMap(), raw: statRaw }
    // Mask on an axis-swapped grid (voxel (a,b,c) → world (b,a,c)), non-zero only
    // where its own x-coord a < 4. Correct sampling maps stat (i,j,k) → mask
    // (j,i,k), so the restriction becomes stat j < 4; a transposed walk would
    // instead restrict on i and let the whole blob through.
    const swap = new Float64Array([0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
    const maskRaw = new Float32Array(N * N * N)
    for (let c = 0; c < N; c++)
      for (let b = 0; b < N; b++) for (let a = 0; a < 4; a++) maskRaw[a + b * N + c * N * N] = 1
    const maskVol: Volume = { ...zMap(), name: 'mask', affine: swap, raw: maskRaw }

    const domain = createCorrectionDomain({ get, set, timers })
    host.overlays = [
      {
        ...mapLayer(1, statVol),
        correction: { ...defaultCorrectionConfig(statVol.statistic), maskLayerId: 2, rev: 1 }
      },
      mapLayer(2, maskVol)
    ]
    domain.configChanged(1)
    flush()
    // Restriction j<4 keeps blob columns j∈{2,3}: 2 (i) · 2 (j) · 6 (k) = 24.
    expect(host.overlays[0].significance?.survivingVoxels).toBe(24)
  })

  it('does not restrict when the mask affine is singular', () => {
    const N = 12
    const singular = new Float64Array(16) // zero linear part → non-invertible
    singular[15] = 1
    // Mask content is all-zero, yet a singular affine falls back to "don't
    // restrict" (fill 1), so the whole blob survives rather than being hidden.
    const maskVol: Volume = {
      ...zMap(),
      name: 'mask',
      affine: singular,
      raw: new Float32Array(N * N * N)
    }
    const domain = createCorrectionDomain({ get, set, timers })
    const stat = zMap()
    host.overlays = [
      {
        ...mapLayer(1, stat),
        correction: { ...defaultCorrectionConfig(stat.statistic), maskLayerId: 2, rev: 1 }
      },
      mapLayer(2, maskVol)
    ]
    domain.configChanged(1)
    flush()
    expect(host.overlays[0].significance?.survivingVoxels).toBe(4 * 4 * 4)
  })
})

describe('createCorrectionDomain — worker path', () => {
  let host: CorrectionHostState
  let scheduled: (() => void) | null
  const get = (): CorrectionHostState => host
  const set = (
    patch: Partial<CorrectionHostState> | ((s: CorrectionHostState) => Partial<CorrectionHostState>)
  ): void => {
    Object.assign(host, typeof patch === 'function' ? patch(host) : patch)
  }
  const timers = {
    setTimeout: (cb: () => void) => {
      scheduled = cb
      return 1 as unknown as ReturnType<typeof setTimeout>
    },
    clearTimeout: () => {
      scheduled = null
    }
  }
  const flush = (): void => {
    const cb = scheduled
    scheduled = null
    cb?.()
  }

  // A runner that defers completion/error so the test can settle it manually.
  let deferred: (() => void) | null
  let deferredError: (() => void) | null
  const runner = {
    run: vi.fn(
      (
        _token: number,
        _vs: number,
        _layerId: number,
        request: CorrectionRequest,
        cb: { complete(r: ReturnType<typeof computeCorrection>): void; error(m: string): void }
      ) => {
        deferred = () => cb.complete(computeCorrection(request))
        deferredError = () => cb.error('boom')
        return true
      }
    ),
    cancel: vi.fn(),
    dispose: vi.fn()
  }

  beforeEach(() => {
    host = { overlays: [mapLayer(1, zMap())], frame: 0, volumeSession: 1, correctionAtlas: null }
    scheduled = null
    deferred = null
    deferredError = null
    runner.run.mockClear()
    runner.cancel.mockClear()
  })

  const enable = (id: number): void => {
    host.overlays = host.overlays.map((l) =>
      l.id === id ? { ...l, correction: defaultCorrectionConfig(l.volume.statistic) } : l
    )
  }

  it('dispatches to the worker and writes the async result', () => {
    const domain = createCorrectionDomain({ get, set, timers, runner })
    enable(1)
    domain.configChanged(1)
    flush()
    expect(runner.run).toHaveBeenCalledTimes(1)
    expect(host.overlays[0].significance).toBeNull() // async, not yet
    deferred!()
    expect(host.overlays[0].significance?.survivingVoxels).toBe(4 * 4 * 4)
  })

  it('discards a stale worker result after the config revision moves on', () => {
    const domain = createCorrectionDomain({ get, set, timers, runner })
    enable(1)
    domain.configChanged(1)
    flush()
    // The user edits again while the worker is in flight.
    host.overlays = host.overlays.map((l) =>
      l.id === 1 ? { ...l, correction: { ...l.correction!, alpha: 0.001, rev: 99 } } : l
    )
    deferred!() // the old run completes — its result is now stale
    expect(host.overlays[0].significance).toBeNull()
  })

  it('marks the existing significance stale while a recompute is queued', () => {
    const domain = createCorrectionDomain({ get, set, timers, runner })
    enable(1)
    domain.configChanged(1)
    flush()
    deferred!()
    expect(host.overlays[0].significance?.stale).toBe(false)
    // A subsequent edit should flip the visible significance to stale immediately.
    domain.configChanged(1)
    expect(host.overlays[0].significance?.stale).toBe(true)
  })

  it('clears significance when the worker reports an error', () => {
    const domain = createCorrectionDomain({ get, set, timers, runner })
    enable(1)
    domain.configChanged(1)
    flush()
    deferred!()
    expect(host.overlays[0].significance).not.toBeNull()
    domain.configChanged(1)
    flush()
    deferredError!()
    expect(host.overlays[0].significance).toBeNull()
  })

  it('cancels the in-flight worker when its layer is removed', () => {
    const domain = createCorrectionDomain({ get, set, timers, runner })
    enable(1)
    domain.configChanged(1)
    flush() // worker now running for layer 1
    domain.overlayRemoved(1)
    expect(runner.cancel).toHaveBeenCalledTimes(1)
  })

  it('cancels the in-flight worker when correction is toggled off', () => {
    const domain = createCorrectionDomain({ get, set, timers, runner })
    enable(1)
    domain.configChanged(1)
    flush() // worker now running for layer 1
    host.overlays = host.overlays.map((l) => (l.id === 1 ? { ...l, correction: null } : l))
    domain.configChanged(1)
    expect(runner.cancel).toHaveBeenCalledTimes(1)
  })

  it('annotates cluster peaks and overlap when an atlas is selected', () => {
    const N = 12
    const atlasVolume: Volume = {
      ...zMap(),
      name: 'atlas',
      datatypeCode: 2,
      datatypeName: 'uint8',
      raw: new Uint8Array(N * N * N).fill(1)
    }
    const atlas = { volume: atlasVolume, names: new Map([[1, 'Region1']]) }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const atlasProvider: any = {
      get: () => Promise.resolve(atlas),
      getCached: () => atlas,
      dispose: () => undefined
    }
    host.correctionAtlas = 'aal3'
    const domain = createCorrectionDomain({ get, set, timers, runner, atlasProvider })
    enable(1)
    domain.configChanged(1)
    flush()
    deferred!() // the report is annotated on the main thread after the worker returns
    const record = host.overlays[0].significance?.report?.records[0]
    expect(record?.peakRegion).toBe('Region1')
    expect(record?.regions).toContain('Region1(100%)')
  })

  it('re-annotates on atlas change without re-running the worker', async () => {
    const N = 12
    const atlasVolume: Volume = {
      ...zMap(),
      name: 'atlas',
      datatypeCode: 2,
      datatypeName: 'uint8',
      raw: new Uint8Array(N * N * N).fill(1)
    }
    const atlas = { volume: atlasVolume, names: new Map([[1, 'Region1']]) }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const atlasProvider: any = {
      get: vi.fn(() => Promise.resolve(atlas)),
      getCached: () => atlas,
      dispose: () => undefined
    }
    const domain = createCorrectionDomain({ get, set, timers, runner, atlasProvider })
    enable(1)
    domain.configChanged(1)
    flush()
    deferred!() // one correction, no atlas selected yet → report is not annotated
    expect(runner.run).toHaveBeenCalledTimes(1)
    expect(host.overlays[0].significance?.report?.records[0].peakRegion).toBeUndefined()

    // Selecting an atlas re-annotates from the retained membership — no recompute.
    host.correctionAtlas = 'aal3'
    domain.atlasChanged()
    await atlasProvider.get('aal3')
    await Promise.resolve()

    expect(runner.run).toHaveBeenCalledTimes(1) // the worker was NOT run again
    const record = host.overlays[0].significance?.report?.records[0]
    expect(record?.peakRegion).toBe('Region1')
    expect(record?.regions).toContain('Region1(100%)')
  })

  it('ignores a slow atlas load that resolves after the selection moved on', async () => {
    const N = 12
    const mkAtlas = (name: string): { volume: Volume; names: Map<number, string> } => ({
      volume: {
        ...zMap(),
        name,
        datatypeCode: 2,
        datatypeName: 'uint8',
        raw: new Uint8Array(N * N * N).fill(1)
      } as Volume,
      names: new Map([[1, name]])
    })
    const atlasA = mkAtlas('AtlasA')
    const atlasB = mkAtlas('AtlasB')
    const cached: Record<string, ReturnType<typeof mkAtlas>> = {}
    let resolveA: () => void = () => undefined
    // A loads slowly (deferred); B is available immediately.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const atlasProvider: any = {
      get: (id: string) => {
        if (id === 'A') {
          return new Promise<void>((res) => {
            resolveA = () => {
              cached.A = atlasA
              res()
            }
          }).then(() => atlasA)
        }
        cached[id] = atlasB
        return Promise.resolve(atlasB)
      },
      getCached: (id: string) => cached[id] ?? null,
      dispose: () => undefined
    }
    const domain = createCorrectionDomain({ get, set, timers, runner, atlasProvider })
    enable(1)
    domain.configChanged(1)
    flush()
    deferred!()

    // Select A (still loading), then B (resolves immediately) → report shows B.
    host.correctionAtlas = 'A'
    domain.atlasChanged()
    host.correctionAtlas = 'B'
    domain.atlasChanged()
    await Promise.resolve()
    expect(host.overlays[0].significance?.report?.records[0].peakRegion).toBe('AtlasB')

    // A's slow load finally resolves — it must NOT overwrite the current B.
    resolveA()
    await Promise.resolve()
    await Promise.resolve()
    expect(host.overlays[0].significance?.report?.records[0].peakRegion).toBe('AtlasB')
  })
})
