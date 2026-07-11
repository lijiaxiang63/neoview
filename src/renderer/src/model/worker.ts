import * as tf from '@tensorflow/tfjs'
import { MODEL_ASSETS, modelVariant, type ModelAssetId } from './catalog'
import {
  cropModelInput,
  keepLargestComponents,
  mapModelOutput,
  modelInputNormalization,
  prepareModelGrid,
  restoreModelTarget,
  type PreparedModelInput
} from './preprocess'
import { initializeModelBackend, loadVerifiedModel, runModel } from './modelCore'
import { modelAssetUrls } from './workerAssets'
import type {
  ModelErrorCode,
  ModelProgressStage,
  ModelWorkerRequest,
  ModelWorkerResponse
} from './protocol'

interface AssetBytes {
  json: ArrayBuffer
  weights: ArrayBuffer
  colors: ArrayBuffer | null
}

const post = (message: ModelWorkerResponse, transfer?: Transferable[]): void => {
  self.postMessage(message, transfer ?? [])
}

function progress(request: ModelWorkerRequest, stage: ModelProgressStage, value: number): void {
  post({
    type: 'progress',
    token: request.token,
    volumeSession: request.volumeSession,
    variantId: request.variantId,
    stage,
    progress: Math.max(0, Math.min(1, value))
  })
}

async function fetchBytes(url: URL): Promise<ArrayBuffer> {
  const response = await fetch(url)
  if (!response.ok) throw new Error('asset-failed')
  return await response.arrayBuffer()
}

async function fetchAsset(id: ModelAssetId): Promise<AssetBytes> {
  const urls = modelAssetUrls(id)
  try {
    const [json, weights, colors] = await Promise.all([
      fetchBytes(urls.json),
      fetchBytes(urls.weights),
      urls.colors ? fetchBytes(urls.colors) : Promise.resolve(null)
    ])
    return { json, weights, colors }
  } catch {
    throw new Error('asset-failed')
  }
}

function errorCode(error: unknown): ModelErrorCode {
  const message = error instanceof Error ? error.message : ''
  if (message === 'unsupported') return 'unsupported'
  if (message === 'asset-failed') return 'asset-failed'
  if (message === 'asset-invalid') return 'asset-invalid'
  if (message === 'prepare-failed') return 'prepare-failed'
  return 'run-failed'
}

async function runPrepared(
  model: tf.LayersModel,
  input: PreparedModelInput,
  execution: 'high' | 'low',
  start: number,
  end: number,
  request: ModelWorkerRequest,
  stage: 'prerequisite' | 'infer'
): Promise<Uint8Array> {
  return await runModel(
    execution,
    model,
    input.data,
    input.dims,
    input.inputMin,
    input.inputScale,
    (completed, total) => progress(request, stage, start + (completed / total) * (end - start))
  )
}

async function run(request: ModelWorkerRequest): Promise<void> {
  let mainModel: tf.LayersModel | null = null
  let prerequisiteModel: tf.LayersModel | null = null
  try {
    const variant = modelVariant(request.variantId)
    const mainSpec = MODEL_ASSETS[variant.assetId]
    await initializeModelBackend()

    const grid = prepareModelGrid(
      request.raw,
      request.dims,
      request.affine,
      request.datatypeCode,
      request.slope,
      request.inter,
      (value) => progress(request, 'prepare', value)
    )
    if (!grid) throw new Error('prepare-failed')
    request.raw = new Uint8Array(0)
    progress(request, 'prepare', 0.2)

    const [mainBytes, prerequisiteBytes] = await Promise.all([
      fetchAsset(variant.assetId),
      variant.prerequisite ? fetchAsset(variant.prerequisite) : Promise.resolve(null)
    ])
    progress(request, 'load', 0.23)

    mainModel = await loadVerifiedModel(
      mainSpec,
      mainBytes.json,
      mainBytes.weights,
      mainBytes.colors
    )
    progress(request, 'load', 0.25)

    let externalMask: Uint8Array | null = null
    if (variant.prerequisite && prerequisiteBytes) {
      const prerequisiteSpec = MODEL_ASSETS[variant.prerequisite]
      prerequisiteModel = await loadVerifiedModel(
        prerequisiteSpec,
        prerequisiteBytes.json,
        prerequisiteBytes.weights,
        prerequisiteBytes.colors
      )
      const normalization = modelInputNormalization(grid.data, 'minmax')
      if (!normalization) throw new Error('prepare-failed')
      const input = cropModelInput(grid, normalization, 0, 18)
      if (!input) throw new Error('prepare-failed')
      const prerequisiteLabels = await runPrepared(
        prerequisiteModel,
        input,
        'high',
        0.25,
        0.4,
        request,
        'prerequisite'
      )
      externalMask = Uint8Array.from(restoreModelTarget(prerequisiteLabels, input), (value) =>
        value === 0 ? 0 : 1
      )
      input.data = new Uint8Array(0)
      prerequisiteModel.dispose()
      prerequisiteModel = null
    }

    const normalization = modelInputNormalization(grid.data, variant.normalization)
    if (!normalization) throw new Error('prepare-failed')
    const prepared = cropModelInput(
      grid,
      normalization,
      variant.threshold,
      variant.padding,
      externalMask
    )
    if (!prepared) throw new Error('prepare-failed')
    grid.data = new Uint8Array(0)
    externalMask = null

    let output = await runPrepared(
      mainModel,
      prepared,
      variant.execution,
      variant.prerequisite ? 0.4 : 0.25,
      0.85,
      request,
      'infer'
    )
    prepared.data = new Uint8Array(0)
    progress(request, 'writeback', 0.85)
    const resultClassCount = variant.output === 'binary' ? 2 : mainSpec.outputClasses
    const filtered = keepLargestComponents(
      output,
      prepared.dims,
      mainSpec.outputClasses,
      variant.output === 'binary'
    )
    output = new Uint8Array(0)
    progress(request, 'writeback', 0.9)
    const result = mapModelOutput(filtered, prepared, request.dims, resultClassCount, (value) =>
      progress(request, 'writeback', value)
    )
    post(
      {
        type: 'complete',
        token: request.token,
        volumeSession: request.volumeSession,
        variantId: request.variantId,
        labels: result.labels,
        counts: result.counts
      },
      [result.labels.buffer, result.counts.buffer]
    )
  } catch (error) {
    post({
      type: 'error',
      token: request.token,
      volumeSession: request.volumeSession,
      variantId: request.variantId,
      code: errorCode(error)
    })
  } finally {
    mainModel?.dispose()
    prerequisiteModel?.dispose()
    tf.disposeVariables()
  }
}

self.onmessage = (event: MessageEvent<ModelWorkerRequest>): void => {
  void run(event.data).finally(() => self.close())
}
