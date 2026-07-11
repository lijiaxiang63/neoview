import { readFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { describe, expect, it } from 'vitest'
import { gunzip, isGzip } from '../src/renderer/src/volume/gunzip'
import { parseVolume } from '../src/renderer/src/volume/parse'
import {
  DEFAULT_MODEL_VARIANT_ID,
  MODEL_ASSETS,
  MODEL_VARIANTS,
  modelClasses,
  modelVariant,
  type ModelVariantId
} from '../src/renderer/src/model/catalog'
import { keepLargestComponents } from '../src/renderer/src/model/preprocess'
import { composeVoxelMap } from '../src/renderer/src/volume/affine'

type CasePair = [candidatePath: string, referencePath: string]
interface CaseRecord {
  candidatePath: string
  referencePath: string
  candidateTablePath?: string
}
type ReferenceCase = CasePair | CaseRecord
type ReferenceManifest = Partial<Record<ModelVariantId, ReferenceCase[]>>

const encoded = process.env.MODEL_REFERENCE_CASES

function asBuffer(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

async function readLabels(path: string): Promise<ReturnType<typeof parseVolume>> {
  const bytes = asBuffer(readFileSync(path))
  return parseVolume('comparison', isGzip(bytes) ? await gunzip(bytes) : bytes)
}

function overlapStats(
  candidate: ArrayLike<number>,
  reference: ArrayLike<number>,
  value: number
): { score: number; candidateCount: number; referenceCount: number; intersection: number } {
  let candidateCount = 0
  let referenceCount = 0
  let intersection = 0
  for (let index = 0; index < candidate.length; index++) {
    const a = candidate[index] === value
    const b = reference[index] === value
    if (a) candidateCount++
    if (b) referenceCount++
    if (a && b) intersection++
  }
  return {
    score: (2 * intersection) / (candidateCount + referenceCount),
    candidateCount,
    referenceCount,
    intersection
  }
}

function unpackCase(item: ReferenceCase): CaseRecord {
  return Array.isArray(item) ? { candidatePath: item[0], referencePath: item[1] } : item
}

function remapCandidate(
  raw: ArrayLike<number>,
  tablePath: string | undefined,
  variantId: ModelVariantId
): Uint16Array {
  if (!tablePath) return Uint16Array.from(raw)
  const classes = modelClasses(variantId)
  const byIdentity = new Map(
    classes.map((item) => [`${item.name}\u0000${item.color.slice(1).toLowerCase()}`, item.value])
  )
  const valueMap = new Map<number, number>([[0, 0]])
  for (const line of readFileSync(tablePath, 'utf8').trim().split('\n')) {
    if (!line) continue
    const [value, red, green, blue, , ...nameParts] = line.split('\t')
    const color = [red, green, blue]
      .map((component) => Number(component).toString(16).padStart(2, '0'))
      .join('')
    const mapped = byIdentity.get(`${nameParts.join('\t')}\u0000${color}`)
    expect(mapped, `${variantId}:${nameParts.join('\t')}`).toBeDefined()
    valueMap.set(Number(value), mapped as number)
  }
  const used = new Set<number>()
  for (let index = 0; index < raw.length; index++) {
    const value = Number(raw[index])
    if (value !== 0) used.add(value)
  }
  for (const value of used) expect(valueMap.has(value), `${variantId}:export-${value}`).toBe(true)
  return Uint16Array.from(raw, (value) => valueMap.get(Number(value)) ?? 0)
}

function referenceTensorOrder(
  raw: ArrayLike<number>,
  dims: [number, number, number],
  binary: boolean
): Uint8Array {
  const [sizeX, sizeY, sizeZ] = dims
  const sizeXY = sizeX * sizeY
  const ordered = new Uint8Array(raw.length)
  let tensorIndex = 0
  for (let x = 0; x < sizeX; x++) {
    for (let y = 0; y < sizeY; y++) {
      for (let z = 0; z < sizeZ; z++, tensorIndex++) {
        const value = Number(raw[x + y * sizeX + z * sizeXY])
        ordered[tensorIndex] = binary ? Number(value !== 0) : value
      }
    }
  }
  return ordered
}

function mapReferenceToCandidate(
  reference: ReturnType<typeof parseVolume>,
  candidate: ReturnType<typeof parseVolume>,
  variantId: ModelVariantId
): Uint16Array {
  const variant = modelVariant(variantId)
  const binary = variant.output === 'binary'
  const [referenceX, referenceY, referenceZ] = reference.dims
  const referenceYZ = referenceY * referenceZ
  const unfiltered = referenceTensorOrder(reference.raw, reference.dims, binary)
  const filtered = keepLargestComponents(
    unfiltered,
    reference.dims,
    MODEL_ASSETS[variant.assetId].outputClasses,
    binary
  )
  const map = composeVoxelMap(candidate.affine, reference.affine)
  expect(map, 'reference affine').not.toBeNull()
  const transform = map as Float64Array
  const [candidateX, candidateY, candidateZ] = candidate.dims
  const labels = new Uint16Array(candidateX * candidateY * candidateZ)
  let outputIndex = 0
  for (let z = 0; z < candidateZ; z++) {
    for (let y = 0; y < candidateY; y++) {
      let xReference = transform[1] * y + transform[2] * z + transform[3]
      let yReference = transform[5] * y + transform[6] * z + transform[7]
      let zReference = transform[9] * y + transform[10] * z + transform[11]
      for (let x = 0; x < candidateX; x++, outputIndex++) {
        const sourceX = Math.round(xReference)
        const sourceY = Math.round(yReference)
        const sourceZ = Math.round(zReference)
        if (
          sourceX >= 0 &&
          sourceX < referenceX &&
          sourceY >= 0 &&
          sourceY < referenceY &&
          sourceZ >= 0 &&
          sourceZ < referenceZ
        ) {
          const value = Number(filtered[sourceX * referenceYZ + sourceY * referenceZ + sourceZ])
          labels[outputIndex] = value
        }
        xReference += transform[0]
        yReference += transform[4]
        zReference += transform[8]
      }
    }
  }
  return labels
}

describe('reference storage conversion', () => {
  it('converts first-axis-fastest storage to last-axis-fastest model order', () => {
    const raw = new Uint8Array(12)
    const dims: [number, number, number] = [2, 2, 3]
    for (let z = 0; z < dims[2]; z++) {
      for (let y = 0; y < dims[1]; y++) {
        for (let x = 0; x < dims[0]; x++) {
          raw[x + y * dims[0] + z * dims[0] * dims[1]] = x + y * 10 + z * 50
        }
      }
    }
    expect(referenceTensorOrder(raw, dims, false)).toEqual(
      new Uint8Array([0, 50, 100, 10, 60, 110, 1, 51, 101, 11, 61, 111])
    )
  })
})

describe.skipIf(!encoded)('local model reference comparison', () => {
  it(
    'meets the per-class overlap gate for every selectable mode',
    { timeout: 120_000 },
    async () => {
      const manifest = JSON.parse(encoded as string) as ReferenceManifest
      const failures: string[] = []
      for (const variant of MODEL_VARIANTS) {
        const pairs = manifest[variant.id] ?? []
        expect(pairs.length, variant.id).toBeGreaterThanOrEqual(
          variant.id === DEFAULT_MODEL_VARIANT_ID ? 3 : 1
        )
        for (const item of pairs) {
          const { candidatePath, referencePath, candidateTablePath } = unpackCase(item)
          const [candidate, reference] = await Promise.all([
            readLabels(candidatePath),
            readLabels(referencePath)
          ])
          const candidateLabels = remapCandidate(candidate.raw, candidateTablePath, variant.id)
          const referenceLabels = mapReferenceToCandidate(reference, candidate, variant.id)
          expect(candidateLabels.length).toBe(referenceLabels.length)
          const values = new Set<number>()
          for (let index = 0; index < candidateLabels.length; index++) {
            if (candidateLabels[index] !== 0) values.add(candidateLabels[index])
            if (referenceLabels[index] !== 0) values.add(referenceLabels[index])
          }
          for (const value of values) {
            const result = overlapStats(candidateLabels, referenceLabels, value)
            if (result.score < 0.995) {
              failures.push(
                `${basename(dirname(candidatePath))}:${variant.id}:${value} score=${result.score.toFixed(6)} candidate=${result.candidateCount} reference=${result.referenceCount} intersection=${result.intersection}`
              )
            }
          }
        }
      }
      expect(failures).toEqual([])
    }
  )
})
