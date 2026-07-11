import { readFile } from 'node:fs/promises'
import * as tf from '@tensorflow/tfjs'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  DEFAULT_MODEL_VARIANT_ID,
  MODEL_ASSETS,
  MODEL_GROUPS,
  MODEL_VARIANTS,
  modelClasses,
  type ModelAssetId
} from '../src/renderer/src/model/catalog'
import { loadVerifiedModel, sha256, validateStoredModel } from '../src/renderer/src/model/modelCore'
import { modelAssetUrls } from '../src/renderer/src/model/workerAssets'

const ASSET_DIRS: Readonly<Record<ModelAssetId, string>> = {
  'hidden-light': '',
  'tissue-3': 'model20chan3cls',
  'subcortical-18': 'model30chan18cls',
  'compact-18': 'model18cls',
  'aparc-50': 'model30chan50cls',
  'extract-3': 'model11_gw_ae',
  'aparc-104': 'model21_104class',
  'mindgrab-2': 'mindgrab'
}

function bytesOf(value: Buffer): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer
}

function pathOf(id: ModelAssetId, name: string): string {
  const directory = ASSET_DIRS[id]
  return `src/renderer/src/model/assets/${directory ? `${directory}/` : ''}${name}`
}

describe('model catalog', () => {
  beforeAll(async () => {
    await tf.setBackend('cpu')
    await tf.ready()
  })

  it('contains seven groups, fourteen selectable modes, and one hidden prerequisite', () => {
    expect(MODEL_GROUPS).toHaveLength(7)
    expect(MODEL_VARIANTS).toHaveLength(14)
    expect(DEFAULT_MODEL_VARIANT_ID).toBe('tissue-high')
    expect(new Set(MODEL_GROUPS.flatMap((group) => group.variantIds)).size).toBe(14)
    expect(MODEL_VARIANTS.some((variant) => variant.assetId === 'hidden-light')).toBe(false)
    expect(
      MODEL_VARIANTS.filter((variant) => variant.prerequisite === 'hidden-light')
    ).toHaveLength(4)
  })

  it('provides a complete class table for every mode', () => {
    for (const variant of MODEL_VARIANTS) {
      const classes = modelClasses(variant.id)
      const expected = variant.output === 'binary' ? 2 : MODEL_ASSETS[variant.assetId].outputClasses
      expect(classes, variant.id).toHaveLength(expected)
      expect(classes.map((item) => item.value)).toEqual(classes.map((_, index) => index))
      expect(classes.every((item) => /^#[0-9a-f]{6}$/i.test(item.color))).toBe(true)
    }
  })

  it('forces color tables to remain same-origin build assets', () => {
    for (const id of Object.keys(MODEL_ASSETS) as ModelAssetId[]) {
      const colors = modelAssetUrls(id).colors
      if (id === 'hidden-light') expect(colors).toBeNull()
      else expect(colors?.searchParams.has('no-inline'), id).toBe(true)
    }
  })

  it('pins every bundled resource and validates each stored architecture', async () => {
    for (const [id, spec] of Object.entries(MODEL_ASSETS) as [
      ModelAssetId,
      (typeof MODEL_ASSETS)[ModelAssetId]
    ][]) {
      const [json, weights, colors] = await Promise.all([
        readFile(pathOf(id, 'model.json')),
        readFile(pathOf(id, 'weights.bin')),
        spec.colorsHash ? readFile(pathOf(id, 'colormap.json')) : Promise.resolve(null)
      ])
      expect(await sha256(bytesOf(json)), `${id} json`).toBe(spec.jsonHash)
      expect(await sha256(bytesOf(weights)), `${id} weights`).toBe(spec.weightsHash)
      expect(weights.byteLength, `${id} weight length`).toBe(spec.weightsBytes)
      expect(
        validateStoredModel(JSON.parse(json.toString('utf8')), weights.byteLength, spec),
        `${id} architecture`
      ).toBe(true)
      if (colors) expect(await sha256(bytesOf(colors)), `${id} colors`).toBe(spec.colorsHash)
      const model = await loadVerifiedModel(
        spec,
        bytesOf(json),
        bytesOf(weights),
        colors ? bytesOf(colors) : null
      )
      expect(model.layers, `${id} loaded layers`).toHaveLength(spec.layerCount)
      model.dispose()
    }
  })
})
