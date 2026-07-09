import { describe, expect, it } from 'vitest'
// @ts-expect-error plain mjs helper shared with the fixture generator
import { buildVolume } from '../scripts/make-test-volumes.mjs'
import { parseVolume } from '../src/renderer/src/volume/parse'
import {
  buildLabelTexData,
  buildTexData,
  floatToHalf,
  halfExtents,
  normalizeFrame,
  planTexture,
  scaledToNormalized
} from '../src/renderer/src/render3d/normalize'

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

describe('normalizeFrame', () => {
  it('maps the scaled data range onto [0, 1]', () => {
    // int16 with slope 0.5 / inter -25: raw 100 -> 25, raw 2000 -> 975.
    const buf = buildVolume({
      dims: [4, 4, 4],
      dtype: 'int16',
      slope: 0.5,
      inter: -25,
      value: (i: number, j: number, k: number) => (i === 0 && j === 0 && k === 0 ? 2000 : 100)
    })
    const vol = parseVolume('t.nii', toArrayBuffer(buf))
    const out = normalizeFrame(vol, 0)
    expect(out[0]).toBeCloseTo(1) // scaled max
    expect(out[1]).toBeCloseTo(0) // scaled min
  })

  it('selects the correct 4D frame slab', () => {
    const buf = buildVolume({
      dims: [4, 4, 2, 3],
      dtype: 'float32',
      value: (_i: number, _j: number, k: number, t: number) => k + 100 * t
    })
    const vol = parseVolume('t.nii', toArrayBuffer(buf))
    // Data range is 0 .. 201 (k in 0..1, t in 0..2).
    const f2 = normalizeFrame(vol, 2)
    expect(f2[0]).toBeCloseTo(200 / 201)
    const f0 = normalizeFrame(vol, 0)
    expect(f0[0]).toBeCloseTo(0)
  })

  it('reuses a provided output buffer', () => {
    const buf = buildVolume({ dims: [2, 2, 2], dtype: 'uint8', value: () => 5 })
    const vol = parseVolume('t.nii', toArrayBuffer(buf))
    const out = new Float32Array(8)
    expect(normalizeFrame(vol, 0, out)).toBe(out)
  })

  it('handles a degenerate (constant) volume without NaN', () => {
    const buf = buildVolume({ dims: [2, 2, 2], dtype: 'uint8', value: () => 7 })
    const vol = parseVolume('t.nii', toArrayBuffer(buf))
    const out = normalizeFrame(vol, 0)
    for (const v of out) expect(Number.isFinite(v)).toBe(true)
  })
})

describe('scaledToNormalized', () => {
  it('maps range bounds into texture space, allowing out-of-range presets', () => {
    const buf = buildVolume({
      dims: [2, 2, 2],
      dtype: 'int16',
      value: (i: number) => i * 100 // scaled range 0..100
    })
    const vol = parseVolume('t.nii', toArrayBuffer(buf))
    expect(scaledToNormalized(vol, 0)).toBeCloseTo(0)
    expect(scaledToNormalized(vol, 100)).toBeCloseTo(1)
    expect(scaledToNormalized(vol, 200)).toBeCloseTo(2) // beyond data range is fine
    expect(scaledToNormalized(vol, -100)).toBeCloseTo(-1)
  })
})

describe('halfExtents', () => {
  it('normalizes physical extents so the longest axis spans 1', () => {
    expect(halfExtents([64, 64, 40], [1, 1, 2.5])).toEqual([0.32, 0.32, 0.5])
  })

  it('isotropic cube gives 0.5 everywhere', () => {
    expect(halfExtents([128, 128, 128], [1, 1, 1])).toEqual([0.5, 0.5, 0.5])
  })
})

describe('planTexture', () => {
  it('keeps small volumes at full resolution', () => {
    const plan = planTexture([64, 64, 40], [1, 1, 2.5])
    expect(plan.stride).toEqual([1, 1, 1])
    expect(plan.texDims).toEqual([64, 64, 40])
    expect(plan.texSpacing).toEqual([1, 1, 2.5])
  })

  it('strides the largest axes until under budget, preserving physical size', () => {
    const plan = planTexture([344, 1024, 1024], [0.5, 0.23, 0.23])
    expect(plan.texDims[0] * plan.texDims[1] * plan.texDims[2]).toBeLessThanOrEqual(128 * 2 ** 20)
    expect(plan.stride).toEqual([1, 2, 2])
    expect(plan.texDims).toEqual([344, 512, 512])
    // Physical extent per axis is unchanged: texDims * texSpacing ≈ dims * spacing.
    for (let a = 0; a < 3; a++) {
      expect(plan.texDims[a] * plan.texSpacing[a]).toBeCloseTo(
        [344, 1024, 1024][a] * [0.5, 0.23, 0.23][a],
        0
      )
    }
  })

  it('respects a custom budget', () => {
    const plan = planTexture([64, 64, 64], [1, 1, 1], 64 * 64 * 16)
    expect(plan.texDims[0] * plan.texDims[1] * plan.texDims[2]).toBeLessThanOrEqual(64 * 64 * 16)
  })

  it('preserves the exact physical extent when an axis is not stride-divisible', () => {
    // 513 @ stride 2 rounds up to 257 texels; spacing*stride would render
    // 514 voxels of physical size while the slice views show 513.
    const plan = planTexture([513, 4, 4], [1, 1, 1], 257 * 4 * 4)
    expect(plan.stride).toEqual([2, 1, 1])
    expect(plan.texDims).toEqual([257, 4, 4])
    for (let a = 0; a < 3; a++) {
      expect(plan.texDims[a] * plan.texSpacing[a]).toBe([513, 4, 4][a])
    }
  })
})

describe('floatToHalf', () => {
  const HALF_ONE = 0x3c00
  it('encodes exact values', () => {
    expect(floatToHalf(0)).toBe(0)
    expect(floatToHalf(1)).toBe(HALF_ONE)
    expect(floatToHalf(0.5)).toBe(0x3800)
    expect(floatToHalf(-1)).toBe(0x8000 | HALF_ONE)
  })

  it('stays monotonic over [0, 1]', () => {
    let prev = -1
    for (let i = 0; i <= 1000; i++) {
      const h = floatToHalf(i / 1000)
      expect(h).toBeGreaterThanOrEqual(prev)
      prev = h
    }
  })
})

describe('buildLabelTexData', () => {
  it('maps region ids through the palette at unit stride', () => {
    const dims: [number, number, number] = [2, 2, 2]
    const plan = planTexture(dims, [1, 1, 1])
    const labelMap = new Uint16Array([0, 1, 0, 2, 0, 0, 9, 0])
    const indexOf = new Uint8Array([0, 1, 2]) // id 9 has no slot -> 0
    expect(Array.from(buildLabelTexData(labelMap, dims, plan, indexOf))).toEqual([
      0, 1, 0, 2, 0, 0, 0, 0
    ])
  })

  it('keeps a region thinner than the stride visible when downsampling', () => {
    const dims: [number, number, number] = [4, 4, 4]
    // An 8-texel budget forces stride 2 on every axis.
    const plan = planTexture(dims, [1, 1, 1], 8)
    expect(plan.stride).toEqual([2, 2, 2])
    const labelMap = new Uint16Array(64)
    // One labeled voxel at (3,3,3) — off the stride grid, so a point sample
    // at block origins would drop the region from the 3D view entirely.
    labelMap[3 * 16 + 3 * 4 + 3] = 1
    const tex = buildLabelTexData(labelMap, dims, plan, new Uint8Array([0, 1]))
    expect(tex[1 * 4 + 1 * 2 + 1]).toBe(1) // texel (1,1,1) of the 2x2x2 grid
    expect(Array.from(tex).filter((v) => v !== 0)).toHaveLength(1)
  })

  it('clips edge blocks and scans past ids without a palette slot', () => {
    const dims: [number, number, number] = [3, 1, 1]
    const plan = planTexture(dims, [1, 1, 1], 2)
    expect(plan.stride).toEqual([2, 1, 1])
    // Block 0 = [id 7 (no slot), id 2]; block 1 = the clipped tail voxel.
    const labelMap = new Uint16Array([7, 2, 2])
    const indexOf = new Uint8Array([0, 0, 5])
    expect(Array.from(buildLabelTexData(labelMap, dims, plan, indexOf))).toEqual([5, 5])
  })
})

describe('buildTexData', () => {
  it('matches normalizeFrame at stride 1 (modulo half precision)', () => {
    const buf = buildVolume({ dims: [8, 6, 4], dtype: 'uint8', value: (i: number) => i * 30 })
    const vol = parseVolume('t.nii', toArrayBuffer(buf))
    const plan = planTexture(vol.dims, vol.spacing)
    const half = buildTexData(vol, 0, plan)
    const float = normalizeFrame(vol, 0)
    expect(half.length).toBe(float.length)
    expect(half[0]).toBe(floatToHalf(float[0]))
    expect(half[5]).toBe(floatToHalf(float[5]))
  })

  it('stride sampling picks every Nth voxel', () => {
    const buf = buildVolume({ dims: [8, 8, 8], dtype: 'uint8', value: (i: number) => i * 8 })
    const vol = parseVolume('t.nii', toArrayBuffer(buf))
    const plan = planTexture(vol.dims, vol.spacing, 8 * 8 * 4) // force stride 2 on one axis
    const data = buildTexData(vol, 0, plan)
    expect(data.length).toBe(plan.texDims[0] * plan.texDims[1] * plan.texDims[2])
    // Axis-0 ramp: if axis 0 was strided, adjacent texels skip one source step.
    if (plan.stride[0] === 2) {
      expect(data[1]).toBe(floatToHalf((2 * 8) / 56))
    }
  })

  it('selects 4D frames', () => {
    const buf = buildVolume({
      dims: [4, 4, 2, 3],
      dtype: 'float32',
      value: (_i: number, _j: number, k: number, t: number) => k + 100 * t
    })
    const vol = parseVolume('t.nii', toArrayBuffer(buf))
    const plan = planTexture(vol.dims, vol.spacing)
    const f2 = buildTexData(vol, 2, plan)
    expect(f2[0]).toBe(floatToHalf(200 / 201))
  })
})
