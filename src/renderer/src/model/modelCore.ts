import * as tf from '@tensorflow/tfjs'
import type { ModelAssetSpec, ModelExecution } from './catalog'

interface StoredLayer {
  class_name?: unknown
  config?: {
    batch_input_shape?: unknown
    dtype?: unknown
    filters?: unknown
    kernel_size?: unknown
    dilation_rate?: unknown
    strides?: unknown
    padding?: unknown
    data_format?: unknown
    activation?: unknown
    name?: unknown
  }
}

interface StoredModel {
  format?: unknown
  generatedBy?: unknown
  convertedBy?: unknown
  modelTopology?: {
    model_config?: { config?: { layers?: StoredLayer[] } }
  }
  weightsManifest?: Array<{
    paths?: unknown
    weights?: tf.io.WeightsManifestEntry[]
  }>
}

interface ConvLayerLike extends tf.layers.Layer {
  strides: number | [number, number, number]
  padding: 'valid' | 'same'
  dilationRate: number | [number, number, number]
}

function equalNumbers(value: unknown, expected: readonly unknown[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  )
}

export async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')
}

export function validateStoredModel(
  value: unknown,
  weightBytes: number,
  spec: ModelAssetSpec
): value is StoredModel {
  if (!value || typeof value !== 'object' || weightBytes !== spec.weightsBytes) return false
  const model = value as StoredModel
  if (model.format !== 'layers-model') return false
  const layers = model.modelTopology?.model_config?.config?.layers
  if (!layers || layers.length !== spec.layerCount || layers[0]?.class_name !== 'InputLayer') {
    return false
  }
  if (
    !equalNumbers(layers[0].config?.batch_input_shape, [null, 256, 256, 256, 1]) ||
    layers[0].config?.dtype !== 'float32'
  ) {
    return false
  }
  for (let index = 1; index < layers.length; index++) {
    const expected = index === layers.length - 1 || index % 2 === 1 ? 'Conv3D' : 'Activation'
    if (layers[index].class_name !== expected) return false
  }
  const convolutions = layers.filter((layer) => layer.class_name === 'Conv3D')
  if (convolutions.length !== spec.convolutionCount) return false
  if (
    convolutions.filter(
      (layer) => typeof layer.config?.name === 'string' && layer.config.name.endsWith('_gn')
    ).length !== spec.normalizedConvolutions
  ) {
    return false
  }
  for (let index = 0; index < convolutions.length; index++) {
    const config = convolutions[index].config
    if (!config) return false
    const output = index === convolutions.length - 1
    if (config.filters !== (output ? spec.outputClasses : spec.hiddenFilters)) return false
    if (!equalNumbers(config.kernel_size, output ? [1, 1, 1] : [3, 3, 3])) return false
    if (
      !equalNumbers(config.dilation_rate, [
        spec.dilations[index],
        spec.dilations[index],
        spec.dilations[index]
      ])
    )
      return false
    if (!equalNumbers(config.strides, [1, 1, 1])) return false
    if (config.padding !== 'same' || config.data_format !== 'channels_last') return false
    if (config.activation !== 'linear') return false
  }
  const activations = layers.filter((layer) => layer.class_name === 'Activation')
  if (
    activations.length !== spec.convolutionCount - 1 ||
    activations.some((layer) => layer.config?.activation !== spec.activation)
  ) {
    return false
  }
  const manifest = model.weightsManifest
  if (
    !Array.isArray(manifest) ||
    manifest.length !== 1 ||
    !Array.isArray(manifest[0].weights) ||
    manifest[0].weights.length !== spec.weightSpecs
  ) {
    return false
  }
  let parameters = 0
  for (const weight of manifest[0].weights) {
    if (weight.dtype !== 'float32' || !Array.isArray(weight.shape)) return false
    parameters += weight.shape.reduce((product, size) => product * size, 1)
  }
  return parameters === spec.parameters
}

function validateColors(value: unknown, expectedLength: number): boolean {
  if (!value || typeof value !== 'object') return false
  const table = value as { R?: unknown; G?: unknown; B?: unknown; labels?: unknown }
  if (
    !Array.isArray(table.R) ||
    !Array.isArray(table.G) ||
    !Array.isArray(table.B) ||
    !Array.isArray(table.labels)
  )
    return false
  const length = table.labels.length
  return (
    length === expectedLength &&
    table.R.length === length &&
    table.G.length === length &&
    table.B.length === length
  )
}

export async function loadVerifiedModel(
  spec: ModelAssetSpec,
  jsonBytes: ArrayBuffer,
  weightBytes: ArrayBuffer,
  colorBytes: ArrayBuffer | null
): Promise<tf.LayersModel> {
  const hashes = await Promise.all([
    sha256(jsonBytes),
    sha256(weightBytes),
    colorBytes ? sha256(colorBytes) : Promise.resolve(null)
  ])
  if (
    hashes[0] !== spec.jsonHash ||
    hashes[1] !== spec.weightsHash ||
    hashes[2] !== spec.colorsHash
  ) {
    throw new Error('asset-invalid')
  }
  const stored = JSON.parse(new TextDecoder().decode(jsonBytes)) as unknown
  if (!validateStoredModel(stored, weightBytes.byteLength, spec)) throw new Error('asset-invalid')
  if (
    colorBytes &&
    !validateColors(JSON.parse(new TextDecoder().decode(colorBytes)), spec.colorClasses)
  ) {
    throw new Error('asset-invalid')
  }
  const model = stored as StoredModel
  const manifest = model.weightsManifest![0]
  const handler: tf.io.IOHandler = {
    load: async () => ({
      modelTopology: model.modelTopology,
      weightSpecs: manifest.weights,
      weightData: weightBytes,
      format: 'layers-model',
      generatedBy: typeof model.generatedBy === 'string' ? model.generatedBy : undefined,
      convertedBy: typeof model.convertedBy === 'string' ? model.convertedBy : undefined
    })
  }
  return await tf.loadLayersModel(handler)
}

function inputTensor(
  input: Uint8Array,
  dims: [number, number, number],
  inputMin: number,
  inputScale: number
): tf.Tensor {
  return tf.tidy(() =>
    tf
      .tensor(input, dims, 'float32')
      .sub(inputMin)
      .div(1 / inputScale)
      .reshape([1, ...dims, 1])
  )
}

async function syncTensor(tensor: tf.Tensor): Promise<void> {
  const probe = tf.tidy(() =>
    tensor.slice(new Array(tensor.rank).fill(0), new Array(tensor.rank).fill(1))
  )
  try {
    await probe.data()
  } finally {
    probe.dispose()
  }
}

async function labelsOf(logits: tf.Tensor): Promise<Uint8Array> {
  const labels = tf.tidy(() => tf.squeeze(tf.argMax(logits, -1)))
  try {
    const values = await labels.data()
    const output = new Uint8Array(values.length)
    for (let index = 0; index < values.length; index++) output[index] = values[index]
    return output
  } finally {
    labels.dispose()
  }
}

function spatialChannelNormalization(input: tf.Tensor): tf.Tensor {
  const { mean, variance } = tf.moments(input, [1, 2, 3], true)
  return input.sub(mean).mul(tf.rsqrt(variance.add(1e-5)))
}

export async function runModelHigh(
  model: tf.LayersModel,
  input: Uint8Array,
  dims: [number, number, number],
  inputMin = 0,
  inputScale = 1,
  onStep?: (completed: number, total: number) => void
): Promise<Uint8Array> {
  let current = inputTensor(input, dims, inputMin, inputScale)
  try {
    const total = model.layers.length - 1
    for (let index = 1; index < model.layers.length; index++) {
      const previous = current
      current = tf.tidy(() => {
        const applied = model.layers[index].apply(previous) as tf.Tensor | tf.Tensor[]
        if (Array.isArray(applied)) throw new Error('run-failed')
        return model.layers[index].name.endsWith('_gn')
          ? spatialChannelNormalization(applied)
          : applied
      })
      previous.dispose()
      await syncTensor(current)
      onStep?.(index, total)
    }
    return await labelsOf(current)
  } finally {
    current.dispose()
  }
}

function convWeights(layer: tf.layers.Layer): { kernel: tf.Tensor5D; bias: tf.Tensor1D | null } {
  const weights = layer.getWeights().map((weight) => weight.clone())
  if (weights.length < 1 || weights.length > 2 || weights[0].rank !== 5) {
    tf.dispose(weights)
    throw new Error('run-failed')
  }
  return {
    kernel: weights[0] as tf.Tensor5D,
    bias: weights.length === 2 ? (weights[1] as tf.Tensor1D) : null
  }
}

function singleOutputConv(
  input: tf.Tensor,
  layer: ConvLayerLike,
  kernel: tf.Tensor5D,
  bias: tf.Tensor1D | null,
  outputChannel: number,
  inputChunkSize: number
): tf.Tensor {
  const inputChannels = input.shape[4]
  if (inputChannels === undefined) throw new Error('run-failed')
  let result: tf.Tensor | null = null
  for (let start = 0; start < inputChannels; start += inputChunkSize) {
    const length = Math.min(inputChunkSize, inputChannels - start)
    const part = tf.tidy(() => {
      const inputSlice = input.slice([0, 0, 0, 0, start], [-1, -1, -1, -1, length])
      const filterSlice = kernel.slice([0, 0, 0, start, outputChannel], [-1, -1, -1, length, 1])
      return tf.conv3d(
        inputSlice as tf.Tensor5D,
        filterSlice as tf.Tensor5D,
        layer.strides,
        layer.padding,
        'NDHWC',
        layer.dilationRate
      )
    })
    if (!result) result = part
    else {
      const previous = result
      result = tf.tidy(() => previous.add(part))
      previous.dispose()
      part.dispose()
    }
  }
  if (!result) throw new Error('run-failed')
  if (bias) {
    const previous = result
    result = tf.tidy(() => previous.add(bias.slice([outputChannel], [1])))
    previous.dispose()
  }
  return result
}

async function sequentialConv(
  input: tf.Tensor,
  layer: ConvLayerLike,
  inputChunkSize: number,
  normalizeChannels: boolean,
  onChannel: () => void
): Promise<tf.Tensor> {
  const { kernel, bias } = convWeights(layer)
  let output: tf.Tensor | null = null
  try {
    const channels = kernel.shape[4]
    for (let channel = 0; channel < channels; channel++) {
      let value = singleOutputConv(input, layer, kernel, bias, channel, inputChunkSize)
      if (normalizeChannels) {
        const previous = value
        value = tf.tidy(() => spatialChannelNormalization(previous))
        previous.dispose()
      }
      if (!output) output = value
      else {
        const previous = output
        output = tf.tidy(() => tf.concat([previous, value], 4))
        previous.dispose()
        value.dispose()
      }
      onChannel()
    }
    if (!output) throw new Error('run-failed')
    return output
  } catch (error) {
    output?.dispose()
    throw error
  } finally {
    kernel.dispose()
    bias?.dispose()
  }
}

async function sequentialArgMax(
  input: tf.Tensor,
  layer: ConvLayerLike,
  inputChunkSize: number,
  onChannel: () => void
): Promise<Uint8Array> {
  const { kernel, bias } = convWeights(layer)
  const outputShape = input.shape.slice(1, 4)
  let best = tf.tidy(() => tf.ones(outputShape).mul(-10_000))
  let labels = tf.zeros(outputShape)
  try {
    const outputChunkSize = 3
    for (let start = 0; start < kernel.shape[4]; start += outputChunkSize) {
      const previousBest = best
      const previousLabels = labels
      ;[best, labels] = tf.tidy(() => {
        let currentBest = previousBest
        let currentLabels = previousLabels
        const end = Math.min(start + outputChunkSize, kernel.shape[4])
        for (let channel = start; channel < end; channel++) {
          const channelKernel = kernel.slice(
            [0, 0, 0, 0, channel],
            [-1, -1, -1, -1, 1]
          ) as tf.Tensor5D
          let score: tf.Tensor | null = null
          const inputChannels = input.shape[4]
          if (inputChannels === undefined) throw new Error('run-failed')
          for (let inputStart = 0; inputStart < inputChannels; inputStart += inputChunkSize) {
            const length = Math.min(inputChunkSize, inputChannels - inputStart)
            const inputSlice = tf.tidy(() =>
              input.slice([0, 0, 0, 0, inputStart], [-1, -1, -1, -1, length])
            ) as tf.Tensor5D
            const filterSlice = tf.tidy(() =>
              channelKernel.slice([0, 0, 0, inputStart, 0], [-1, -1, -1, length, -1])
            ) as tf.Tensor5D
            const convolution = tf.conv3d(inputSlice, filterSlice, 1, 'valid', 'NDHWC', 1)
            inputSlice.dispose()
            filterSlice.dispose()
            const part = tf.squeeze(convolution)
            convolution.dispose()
            if (!score) score = part
            else {
              const previous = score
              score = previous.add(part)
              previous.dispose()
              part.dispose()
            }
            tf.tidy(() => tf.matMul(tf.zeros([1, 1]), tf.zeros([1, 1])))
          }
          if (!score) throw new Error('run-failed')
          if (bias) score = score.add(bias.slice([channel], [1]))
          const greater = score.greater(currentBest)
          currentBest = tf.where(greater, score, currentBest)
          currentLabels = tf.where(greater, tf.fill(outputShape, channel), currentLabels)
          onChannel()
        }
        return [currentBest, currentLabels]
      })
      previousBest.dispose()
      previousLabels.dispose()
    }
    const values = await labels.data()
    const output = new Uint8Array(values.length)
    for (let index = 0; index < values.length; index++) output[index] = values[index]
    return output
  } finally {
    best.dispose()
    labels.dispose()
    kernel.dispose()
    bias?.dispose()
  }
}

function lowWork(model: tf.LayersModel): number {
  let work = 0
  for (let index = 1; index < model.layers.length; index++) {
    if (model.layers[index].getClassName() === 'Conv3D') {
      const config = model.layers[index].getConfig() as { filters?: number }
      work += config.filters ?? 1
    } else work++
  }
  return work
}

export function lowFinalInputChunkSize(outputClasses: number): number {
  return Math.min(10, outputClasses)
}

export async function runModelLow(
  model: tf.LayersModel,
  input: Uint8Array,
  dims: [number, number, number],
  inputMin = 0,
  inputScale = 1,
  onStep?: (completed: number, total: number) => void
): Promise<Uint8Array> {
  let current = inputTensor(input, dims, inputMin, inputScale)
  const total = lowWork(model)
  let completed = 0
  const step = (): void => onStep?.(++completed, total)
  try {
    for (let index = 1; index < model.layers.length - 1; index++) {
      const layer = model.layers[index]
      const previous = current
      if (layer.getClassName() === 'Conv3D') {
        current = await sequentialConv(
          previous,
          layer as ConvLayerLike,
          3,
          layer.name.endsWith('_gn'),
          step
        )
      } else {
        current = tf.tidy(() => {
          const applied = layer.apply(previous) as tf.Tensor | tf.Tensor[]
          if (Array.isArray(applied)) throw new Error('run-failed')
          return applied as tf.Tensor
        })
        step()
      }
      previous.dispose()
      await syncTensor(current)
    }
    const finalLayer = model.layers[model.layers.length - 1] as ConvLayerLike
    const config = finalLayer.getConfig() as { filters?: number }
    if (!config.filters) throw new Error('run-failed')
    return await sequentialArgMax(current, finalLayer, lowFinalInputChunkSize(config.filters), step)
  } finally {
    current.dispose()
  }
}

export async function runModel(
  execution: ModelExecution,
  model: tf.LayersModel,
  input: Uint8Array,
  dims: [number, number, number],
  inputMin: number,
  inputScale: number,
  onStep?: (completed: number, total: number) => void
): Promise<Uint8Array> {
  return execution === 'low'
    ? await runModelLow(model, input, dims, inputMin, inputScale, onStep)
    : await runModelHigh(model, input, dims, inputMin, inputScale, onStep)
}

export async function smokeTestBackend(): Promise<void> {
  const input = tf.ones([1, 2, 2, 2, 1]) as tf.Tensor5D
  const filter = tf.ones([1, 1, 1, 1, 1]) as tf.Tensor5D
  const output = tf.conv3d(input, filter, 1, 'same')
  try {
    const values = await output.data()
    if (values.length !== 8 || values[0] !== 1) throw new Error('unsupported')
  } finally {
    input.dispose()
    filter.dispose()
    output.dispose()
  }
}

export async function initializeModelBackend(
  setBackend: (name: string) => Promise<boolean> = tf.setBackend,
  ready: () => Promise<void> = tf.ready,
  smoke: () => Promise<void> = smokeTestBackend,
  enableProduction: () => void = tf.enableProdMode,
  setFlag: (name: string, value: boolean | number) => void = (name, value) =>
    tf.env().set(name, value)
): Promise<void> {
  try {
    enableProduction()
    setFlag('DEBUG', false)
    setFlag('WEBGL_FORCE_F16_TEXTURES', true)
    setFlag('WEBGL_DELETE_TEXTURE_THRESHOLD', -1)
    if (!(await setBackend('webgl'))) throw new Error('unsupported')
    await ready()
    await smoke()
  } catch {
    throw new Error('unsupported')
  }
}
