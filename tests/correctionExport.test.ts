import { describe, expect, it } from 'vitest'
import {
  buildCorrectedExport,
  buildThresholdedMap
} from '../src/renderer/src/stats/correctionExport'
import { computeCorrection } from '../src/renderer/src/stats/correctionCore'
import type { SignificanceResult } from '../src/renderer/src/stats/correctionConfig'
import { parseVolume } from '../src/renderer/src/volume/parse'
import type { Volume } from '../src/renderer/src/volume/types'

const N = 8
const at = (i: number, j: number, k: number): number => i + j * N + k * N * N

function statMap(): Volume {
  const raw = new Float32Array(N * N * N).fill(0.3)
  for (let k = 1; k < 4; k++)
    for (let j = 1; j < 4; j++) for (let i = 1; i < 4; i++) raw[at(i, j, k)] = 5
  return {
    name: 'map.nii',
    dims: [N, N, N],
    frames: 1,
    spacing: [2, 2, 2],
    datatypeCode: 16,
    datatypeName: 'float32',
    raw,
    slope: 1,
    inter: 0,
    affine: new Float64Array([2, 0, 0, -8, 0, 2, 0, -8, 0, 0, 2, -8, 0, 0, 0, 1]),
    transformSource: 'rows',
    suggestedRange: null,
    labels: null,
    statistic: { kind: 'z', dof1: null, dof2: null },
    smoothness: null,
    stats: { dataMin: 0.3, dataMax: 5, p2: 0.3, p98: 5, typeRange: null }
  }
}

function significance(vol: Volume): SignificanceResult {
  const result = computeCorrection({
    values: Float64Array.from(vol.raw),
    dims: vol.dims,
    affine: vol.affine,
    spacing: vol.spacing,
    statistic: { kind: 'z', dof1: 0, dof2: 0 },
    method: 'uncorrected',
    alpha: 0.05,
    clusterFormingP: 0.001,
    tail: 'two',
    connectivity: 26,
    includeReport: true
  })
  return {
    statThreshold: result.statThreshold,
    minClusterSize: result.minClusterSize,
    mask: result.mask,
    kind: 'z',
    tail: 'two',
    survivingVoxels: result.survivingVoxels,
    smoothness: result.smoothness,
    report: result.report,
    membership: result.membership,
    configRev: 0,
    frame: 0,
    stale: false
  }
}

describe('buildThresholdedMap', () => {
  it('keeps surviving voxels and zeroes the rest', () => {
    const vol = statMap()
    const out = buildThresholdedMap(vol, significance(vol), 0)
    expect(out[at(2, 2, 2)]).toBe(5) // blob interior survives (|5| ≥ 1.96)
    expect(out[at(0, 0, 0)]).toBe(0) // background 0.3 zeroed
    expect(out.filter((v) => v !== 0).length).toBe(27) // the 3³ blob
  })

  it('respects a survival mask', () => {
    const vol = statMap()
    const sig = significance(vol)
    const mask = new Uint8Array(N * N * N) // nothing survives
    const out = buildThresholdedMap(vol, { ...sig, mask }, 0)
    expect(out.every((v) => v === 0)).toBe(true)
  })
})

describe('buildCorrectedExport', () => {
  it('serializes a float32 corrected map that round-trips', async () => {
    const vol = statMap()
    const payload = await buildCorrectedExport(vol, significance(vol), 0, 'map', 'nii')
    expect(payload.fileName).toBe('map.corrected.nii')
    expect(payload.sidecar?.fileName).toBe('map.clusters.csv')
    expect(payload.sidecar?.text.split('\n')[0]).toBe('cluster,voxels,volume,peak,i,j,k,x,y,z')

    const parsed = parseVolume('roundtrip', payload.bytes)
    expect(parsed.datatypeName).toBe('float32')
    expect([...parsed.affine]).toEqual([...vol.affine])
    expect(parsed.raw[at(2, 2, 2)]).toBe(5)
    expect(parsed.raw[at(0, 0, 0)]).toBe(0)
  })
})
