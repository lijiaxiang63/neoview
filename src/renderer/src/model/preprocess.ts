import { mat4, vec4 } from 'gl-matrix'
import type { Volume, VoxelArray } from '../volume/types'
import type { ModelNormalization } from './catalog'
import { MODEL_MAX_SOURCE_BYTES, MODEL_MAX_SOURCE_VOXELS, MODEL_TARGET_DIM } from './protocol'

const TARGET_VOXELS = MODEL_TARGET_DIM ** 3
const HISTOGRAM_BINS = 1000
const CROP_PADDING = 18

export interface ModelTransform {
  targetAffine: Float64Array
  targetToSource: Float64Array
  sourceToTarget: Float64Array
}

export interface PreparedModelInput {
  data: Uint8Array
  dims: [number, number, number]
  corner: [number, number, number]
  sourceToTarget: Float64Array
  inputMin: number
  inputScale: number
}

export interface PreparedModelGrid {
  data: Uint8Array
  sourceToTarget: Float64Array
}

export interface ModelInputNormalization {
  min: number
  scale: number
  max: number
  dataMax: number
}

export interface ModelAvailability {
  available: boolean
  reason: string | null
}

function asColumnMajor(rowMajor: ArrayLike<number>): mat4 {
  return mat4.fromValues(
    rowMajor[0],
    rowMajor[4],
    rowMajor[8],
    rowMajor[12],
    rowMajor[1],
    rowMajor[5],
    rowMajor[9],
    rowMajor[13],
    rowMajor[2],
    rowMajor[6],
    rowMajor[10],
    rowMajor[14],
    rowMajor[3],
    rowMajor[7],
    rowMajor[11],
    rowMajor[15]
  )
}

function asRowMajor(columnMajor: mat4): Float64Array {
  return new Float64Array([
    columnMajor[0],
    columnMajor[4],
    columnMajor[8],
    columnMajor[12],
    columnMajor[1],
    columnMajor[5],
    columnMajor[9],
    columnMajor[13],
    columnMajor[2],
    columnMajor[6],
    columnMajor[10],
    columnMajor[14],
    columnMajor[3],
    columnMajor[7],
    columnMajor[11],
    columnMajor[15]
  ])
}

export function buildModelTransform(
  dims: [number, number, number],
  affineValues: ArrayLike<number>
): ModelTransform | null {
  const inputAffine = asColumnMajor(affineValues)
  const inverseInput = mat4.create()
  if (!mat4.invert(inverseInput, inputAffine)) return null

  const inputCenter = vec4.fromValues(dims[0] / 2, dims[1] / 2, dims[2] / 2, 1)
  vec4.transformMat4(inputCenter, inputCenter, inputAffine)

  const targetAffine = mat4.fromValues(-1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1)
  const targetCenter = vec4.fromValues(
    MODEL_TARGET_DIM / 2,
    MODEL_TARGET_DIM / 2,
    MODEL_TARGET_DIM / 2,
    1
  )
  vec4.transformMat4(targetCenter, targetCenter, targetAffine)
  targetAffine[12] = inputCenter[0] - targetCenter[0]
  targetAffine[13] = inputCenter[1] - targetCenter[1]
  targetAffine[14] = inputCenter[2] - targetCenter[2]

  const targetToSource = mat4.create()
  mat4.multiply(targetToSource, inverseInput, targetAffine)
  const sourceToTarget = mat4.create()
  if (!mat4.invert(sourceToTarget, targetToSource)) return null

  return {
    targetAffine: asRowMajor(targetAffine),
    targetToSource: asRowMajor(targetToSource),
    sourceToTarget: asRowMajor(sourceToTarget)
  }
}

export function modelAvailability(volume: Volume | null): ModelAvailability {
  if (!volume) return { available: false, reason: 'Open a volume first.' }
  if (volume.frames !== 1) {
    return { available: false, reason: 'The built-in model supports single-frame volumes only.' }
  }
  const voxels = volume.dims[0] * volume.dims[1] * volume.dims[2]
  if (voxels > MODEL_MAX_SOURCE_VOXELS || volume.raw.byteLength > MODEL_MAX_SOURCE_BYTES) {
    return { available: false, reason: 'This volume is too large for the built-in model.' }
  }
  if (!buildModelTransform(volume.dims, volume.affine)) {
    return { available: false, reason: 'This volume has a non-invertible affine.' }
  }
  return { available: true, reason: null }
}

export function referenceScale(
  raw: VoxelArray,
  datatypeCode: number,
  slope: number,
  inter: number,
  dims?: [number, number, number]
): { min: number; scale: number } {
  const storedValue = (index: number): number => {
    const value = Math.fround(Number(raw[index]))
    return slope === 1 && inter === 0 ? value : Math.fround(value * slope + inter)
  }
  let min = Infinity
  let max = -Infinity
  let nonzero = 0
  if (dims && dims[0] * dims[1] * dims[2] === raw.length) {
    const border = dims.map((size) => Math.floor(size * 0.25))
    const high = dims.map((size, axis) => size - border[axis])
    const strideZ = dims[0] * dims[1]
    for (let z = border[2]; z < high[2]; z++) {
      for (let y = border[1]; y < high[1]; y++) {
        let index = border[0] + y * dims[0] + z * strideZ
        for (let x = border[0]; x < high[0]; x++, index++) {
          const value = storedValue(index)
          if (!Number.isFinite(value)) continue
          if (value < min) min = value
          if (value > max) max = value
        }
      }
    }
  } else {
    for (let index = 0; index < raw.length; index++) {
      const value = storedValue(index)
      if (!Number.isFinite(value)) continue
      if (value < min) min = value
      if (value > max) max = value
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, scale: 1 }
  if (datatypeCode === 2) return { min, scale: 1 }
  if (!(max > min)) return { min, scale: 1 }

  const binSize = (max - min) / HISTOGRAM_BINS
  const histogram = new Uint32Array(HISTOGRAM_BINS)
  for (let index = 0; index < raw.length; index++) {
    const value = storedValue(index)
    if (!Number.isFinite(value)) continue
    if (Math.abs(value) >= 1e-15) nonzero++
    const bin = Math.min(HISTOGRAM_BINS - 1, Math.floor((value - min) / binSize))
    if (bin < 0) continue
    histogram[bin]++
  }

  const target = raw.length - Math.floor(0.001 * nonzero)
  let cumulative = histogram[0] + histogram[1]
  let upperBin = 0
  while (upperBin < HISTOGRAM_BINS - 1 && cumulative < target) {
    upperBin++
    cumulative += histogram[upperBin + 1] ?? 0
  }
  const upper = min + upperBin * binSize
  return { min, scale: upper !== min ? 255 / (upper - min) : 1 }
}

export function sampleModelLinearValue(
  raw: VoxelArray,
  dims: [number, number, number],
  x: number,
  y: number,
  z: number,
  slope: number,
  inter: number
): number | null {
  const storedValue = (index: number): number => {
    const value = Math.fround(Number(raw[index]))
    return slope === 1 && inter === 0 ? value : Math.fround(value * slope + inter)
  }
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const z0 = Math.floor(z)
  if (x0 < 0 || y0 < 0 || z0 < 0) return null
  const x1 = Math.ceil(x)
  const y1 = Math.ceil(y)
  const z1 = Math.ceil(z)
  if (x1 >= dims[0] || y1 >= dims[1] || z1 >= dims[2]) return null

  const dx = x - x0
  const dy = y - y0
  const dz = z - z0
  const ax = 1 - dx
  const ay = 1 - dy
  const az = 1 - dz
  const strideY = dims[0]
  const strideZ = dims[0] * dims[1]
  const i000 = x0 + y0 * strideY + z0 * strideZ
  const i001 = x0 + y0 * strideY + z1 * strideZ
  const i010 = x0 + y1 * strideY + z0 * strideZ
  const i011 = x0 + y1 * strideY + z1 * strideZ
  const i100 = x1 + y0 * strideY + z0 * strideZ
  const i101 = x1 + y0 * strideY + z1 * strideZ
  const i110 = x1 + y1 * strideY + z0 * strideZ
  const i111 = x1 + y1 * strideY + z1 * strideZ

  let result = 0
  let weight = ax * ay * az
  let value: number
  if (weight !== 0) {
    value = storedValue(i000)
    if (!Number.isFinite(value)) return null
    result += value * weight
  }
  weight = ax * ay * dz
  if (weight !== 0) {
    value = storedValue(i001)
    if (!Number.isFinite(value)) return null
    result += value * weight
  }
  weight = ax * dy * az
  if (weight !== 0) {
    value = storedValue(i010)
    if (!Number.isFinite(value)) return null
    result += value * weight
  }
  weight = ax * dy * dz
  if (weight !== 0) {
    value = storedValue(i011)
    if (!Number.isFinite(value)) return null
    result += value * weight
  }
  weight = dx * ay * az
  if (weight !== 0) {
    value = storedValue(i100)
    if (!Number.isFinite(value)) return null
    result += value * weight
  }
  weight = dx * ay * dz
  if (weight !== 0) {
    value = storedValue(i101)
    if (!Number.isFinite(value)) return null
    result += value * weight
  }
  weight = dx * dy * az
  if (weight !== 0) {
    value = storedValue(i110)
    if (!Number.isFinite(value)) return null
    result += value * weight
  }
  weight = dx * dy * dz
  if (weight !== 0) {
    value = storedValue(i111)
    if (!Number.isFinite(value)) return null
    result += value * weight
  }
  return Math.fround(result)
}

export function sampleModelLinear(
  raw: VoxelArray,
  dims: [number, number, number],
  x: number,
  y: number,
  z: number,
  slope: number,
  inter: number
): number {
  return sampleModelLinearValue(raw, dims, x, y, z, slope, inter) ?? 0
}

export function prepareModelGrid(
  raw: VoxelArray,
  dims: [number, number, number],
  affine: ArrayLike<number>,
  datatypeCode: number,
  slope: number,
  inter: number,
  onProgress?: (progress: number) => void
): PreparedModelGrid | null {
  const transform = buildModelTransform(dims, affine)
  if (!transform) return null
  const target = new Uint8Array(TARGET_VOXELS)
  const { min, scale } = referenceScale(raw, datatypeCode, slope, inter, dims)
  const matrix = transform.targetToSource
  let targetIndex = 0
  for (let z = 0; z < MODEL_TARGET_DIM; z++) {
    for (let y = 0; y < MODEL_TARGET_DIM; y++) {
      const bx = matrix[1] * y + matrix[2] * z + matrix[3]
      const by = matrix[5] * y + matrix[6] * z + matrix[7]
      const bz = matrix[9] * y + matrix[10] * z + matrix[11]
      for (let x = 0; x < MODEL_TARGET_DIM; x++, targetIndex++) {
        const value = sampleModelLinearValue(
          raw,
          dims,
          matrix[0] * x + bx,
          matrix[4] * x + by,
          matrix[8] * x + bz,
          slope,
          inter
        )
        if (value === null) {
          target[targetIndex] = 0
          continue
        }
        const normalized = scale * (value - min)
        target[targetIndex] = Math.trunc(Math.max(0, Math.min(255, normalized)))
      }
    }
    if ((z & 15) === 15) onProgress?.(((z + 1) / MODEL_TARGET_DIM) * 0.2)
  }

  onProgress?.(0.2)
  return { data: target, sourceToTarget: transform.sourceToTarget }
}

function rankValue(histogram: Uint32Array, rank: number): number {
  let cumulative = 0
  for (let value = 0; value < histogram.length; value++) {
    cumulative += histogram[value]
    if (cumulative > rank) return value
  }
  return histogram.length - 1
}

export function modelInputNormalization(
  grid: Uint8Array,
  kind: ModelNormalization
): ModelInputNormalization | null {
  let min = 255
  let max = 0
  const histogram = new Uint32Array(256)
  for (let index = 0; index < grid.length; index++) {
    const value = grid[index]
    histogram[value]++
    if (value < min) min = value
    if (value > max) max = value
  }
  if (kind === 'quantile') {
    const dataMax = max
    min = rankValue(histogram, Math.floor(grid.length * 0.05))
    max = rankValue(histogram, Math.ceil(grid.length * 0.95) - 1)
    if (!(max > min)) return null
    return { min, max, dataMax, scale: 1 / (max - min) }
  }
  if (!(max > min)) return null
  return { min, max, dataMax: max, scale: 1 / (max - min) }
}

function cropBounds(
  grid: Uint8Array,
  normalization: ModelInputNormalization,
  threshold: number,
  padding: number,
  externalMask: Uint8Array | null
): { min: [number, number, number]; max: [number, number, number] } | null {
  if (externalMask && externalMask.length !== grid.length) return null
  const minCorner: [number, number, number] = [MODEL_TARGET_DIM, MODEL_TARGET_DIM, MODEL_TARGET_DIM]
  const maxCorner: [number, number, number] = [-1, -1, -1]
  const normalizedMax = (normalization.dataMax - normalization.min) * normalization.scale
  const cutoff = threshold > 0 ? normalizedMax * threshold : 0
  for (let index = 0; index < grid.length; index++) {
    const included = externalMask
      ? externalMask[index] !== 0
      : (grid[index] - normalization.min) * normalization.scale > cutoff
    if (!included) continue
    const x = index % MODEL_TARGET_DIM
    const y = Math.floor(index / MODEL_TARGET_DIM) % MODEL_TARGET_DIM
    const z = Math.floor(index / (MODEL_TARGET_DIM * MODEL_TARGET_DIM))
    if (x < minCorner[0]) minCorner[0] = x
    if (x > maxCorner[0]) maxCorner[0] = x
    if (y < minCorner[1]) minCorner[1] = y
    if (y > maxCorner[1]) maxCorner[1] = y
    if (z < minCorner[2]) minCorner[2] = z
    if (z > maxCorner[2]) maxCorner[2] = z
  }
  if (maxCorner[0] < 0) return null
  for (let axis = 0; axis < 3; axis++) {
    minCorner[axis] = Math.max(0, minCorner[axis] - padding)
    maxCorner[axis] = Math.min(MODEL_TARGET_DIM - 1, maxCorner[axis] + padding)
  }
  return { min: minCorner, max: maxCorner }
}

function tensorOrderCrop(
  grid: Uint8Array,
  minCorner: [number, number, number],
  maxCorner: [number, number, number]
): { data: Uint8Array; dims: [number, number, number] } {
  const dims: [number, number, number] = [
    maxCorner[0] - minCorner[0] + 1,
    maxCorner[1] - minCorner[1] + 1,
    maxCorner[2] - minCorner[2] + 1
  ]
  const data = new Uint8Array(dims[0] * dims[1] * dims[2])
  let p = 0
  for (let x = 0; x < dims[0]; x++) {
    for (let y = 0; y < dims[1]; y++) {
      let index =
        minCorner[0] +
        x +
        (minCorner[1] + y) * MODEL_TARGET_DIM +
        minCorner[2] * MODEL_TARGET_DIM ** 2
      for (let z = 0; z < dims[2]; z++, p++, index += MODEL_TARGET_DIM ** 2) {
        data[p] = grid[index]
      }
    }
  }
  return { data, dims }
}

export function cropModelInput(
  grid: PreparedModelGrid,
  normalization: ModelInputNormalization,
  threshold: number,
  padding: number,
  externalMask: Uint8Array | null = null
): PreparedModelInput | null {
  const bounds = cropBounds(grid.data, normalization, threshold, padding, externalMask)
  if (!bounds) return null
  const cropped = tensorOrderCrop(grid.data, bounds.min, bounds.max)
  return {
    data: cropped.data,
    dims: cropped.dims,
    corner: bounds.min,
    sourceToTarget: grid.sourceToTarget,
    inputMin: normalization.min,
    inputScale: normalization.scale
  }
}

export function fullModelInput(
  grid: PreparedModelGrid,
  normalization: ModelInputNormalization
): PreparedModelInput {
  const max: [number, number, number] = [
    MODEL_TARGET_DIM - 1,
    MODEL_TARGET_DIM - 1,
    MODEL_TARGET_DIM - 1
  ]
  const ordered = tensorOrderCrop(grid.data, [0, 0, 0], max)
  return {
    data: ordered.data,
    dims: ordered.dims,
    corner: [0, 0, 0],
    sourceToTarget: grid.sourceToTarget,
    inputMin: normalization.min,
    inputScale: normalization.scale
  }
}

export function prepareModelInput(
  raw: VoxelArray,
  dims: [number, number, number],
  affine: ArrayLike<number>,
  datatypeCode: number,
  slope: number,
  inter: number,
  onProgress?: (progress: number) => void
): PreparedModelInput | null {
  const grid = prepareModelGrid(raw, dims, affine, datatypeCode, slope, inter, onProgress)
  if (!grid) return null
  const normalization = modelInputNormalization(grid.data, 'minmax')
  return normalization ? cropModelInput(grid, normalization, 0, CROP_PADDING) : null
}

function floodComponent(
  labels: Uint8Array,
  dims: [number, number, number],
  seed: number,
  visited: Uint8Array,
  queue: Uint32Array,
  output: Uint8Array | null
): number {
  const target = labels[seed]
  let head = 0
  let tail = 1
  queue[0] = seed
  visited[seed] = 1
  if (output) output[seed] = target
  const stride0 = dims[2]
  const stride1 = dims[1] * dims[2]
  while (head < tail) {
    const index = queue[head++]
    const z = index % dims[2]
    const y = Math.floor(index / stride0) % dims[1]
    const x = Math.floor(index / stride1)
    for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx
      if (nx < 0 || nx >= dims[0]) continue
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy
        if (ny < 0 || ny >= dims[1]) continue
        for (let dz = -1; dz <= 1; dz++) {
          if (dx === 0 && dy === 0 && dz === 0) continue
          const nz = z + dz
          if (nz < 0 || nz >= dims[2]) continue
          const next = nx * stride1 + ny * stride0 + nz
          if (visited[next] || labels[next] !== target) continue
          visited[next] = 1
          queue[tail++] = next
          if (output) output[next] = target
        }
      }
    }
  }
  return tail
}

export function keepLargestComponents(
  labels: Uint8Array,
  dims: [number, number, number],
  classCount = 3,
  binary = false
): Uint8Array {
  const source = binary ? Uint8Array.from(labels, (value) => (value === 0 ? 0 : 1)) : labels
  const resultClasses = binary ? 2 : classCount
  const visited = new Uint8Array(source.length)
  const queue = new Uint32Array(source.length)
  const bestSeed = new Int32Array(resultClasses).fill(-1)
  const bestSize = new Uint32Array(resultClasses)
  for (let index = 0; index < source.length; index++) {
    const value = source[index]
    if (value === 0 || value >= resultClasses || visited[index]) continue
    const size = floodComponent(source, dims, index, visited, queue, null)
    if (size > bestSize[value]) {
      bestSize[value] = size
      bestSeed[value] = index
    }
  }
  visited.fill(0)
  const output = new Uint8Array(source.length)
  for (let value = 1; value < resultClasses; value++) {
    if (bestSeed[value] >= 0) floodComponent(source, dims, bestSeed[value], visited, queue, output)
  }
  return output
}

export function mapModelOutput(
  croppedLabels: Uint8Array,
  prepared: Pick<PreparedModelInput, 'dims' | 'corner' | 'sourceToTarget'>,
  sourceDims: [number, number, number],
  classCount = 3,
  onProgress?: (progress: number) => void
): { labels: Uint8Array; counts: Uint32Array } {
  const target = restoreModelTarget(croppedLabels, prepared)

  const labels = new Uint8Array(sourceDims[0] * sourceDims[1] * sourceDims[2])
  const counts = new Uint32Array(classCount)
  const matrix = prepared.sourceToTarget
  let out = 0
  for (let z = 0; z < sourceDims[2]; z++) {
    for (let y = 0; y < sourceDims[1]; y++) {
      const bx = matrix[1] * y + matrix[2] * z + matrix[3]
      const by = matrix[5] * y + matrix[6] * z + matrix[7]
      const bz = matrix[9] * y + matrix[10] * z + matrix[11]
      for (let x = 0; x < sourceDims[0]; x++, out++) {
        const tx = Math.round(matrix[0] * x + bx)
        const ty = Math.round(matrix[4] * x + by)
        const tz = Math.round(matrix[8] * x + bz)
        if (
          tx < 0 ||
          ty < 0 ||
          tz < 0 ||
          tx >= MODEL_TARGET_DIM ||
          ty >= MODEL_TARGET_DIM ||
          tz >= MODEL_TARGET_DIM
        ) {
          counts[0]++
          continue
        }
        const value = target[tx + ty * MODEL_TARGET_DIM + tz * MODEL_TARGET_DIM ** 2]
        if (value < counts.length) {
          labels[out] = value
          counts[value]++
        } else counts[0]++
      }
    }
    if ((z & 7) === 7) onProgress?.(0.9 + ((z + 1) / sourceDims[2]) * 0.1)
  }
  onProgress?.(1)
  return { labels, counts }
}

export function restoreModelTarget(
  croppedLabels: Uint8Array,
  prepared: Pick<PreparedModelInput, 'dims' | 'corner'>
): Uint8Array {
  const target = new Uint8Array(TARGET_VOXELS)
  let p = 0
  for (let x = 0; x < prepared.dims[0]; x++) {
    for (let y = 0; y < prepared.dims[1]; y++) {
      let index =
        prepared.corner[0] +
        x +
        (prepared.corner[1] + y) * MODEL_TARGET_DIM +
        prepared.corner[2] * MODEL_TARGET_DIM ** 2
      for (let z = 0; z < prepared.dims[2]; z++, p++, index += MODEL_TARGET_DIM ** 2) {
        target[index] = croppedLabels[p]
      }
    }
  }
  return target
}
