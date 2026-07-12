import { readFile } from 'node:fs/promises'
import * as tf from '@tensorflow/tfjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  currentMaxStoredElements,
  highFinalNeedsStreaming,
  initializeModelBackend,
  lowFinalInputChunkSize,
  runModelHigh,
  runModelLow,
  sha256,
  smokeTestBackend,
  validateStoredModel
} from '../src/renderer/src/model/modelCore'
import { MODEL_ASSETS } from '../src/renderer/src/model/catalog'

describe('fixed model core', () => {
  beforeAll(async () => {
    await tf.setBackend('cpu')
    await tf.ready()
  })

  afterAll(() => {
    tf.disposeVariables()
  })

  it('pins and validates the bundled assets', async () => {
    const [json, weights] = await Promise.all([
      readFile('src/renderer/src/model/assets/model.json'),
      readFile('src/renderer/src/model/assets/weights.bin')
    ])
    const jsonBuffer = json.buffer.slice(json.byteOffset, json.byteOffset + json.byteLength)
    const weightBuffer = weights.buffer.slice(
      weights.byteOffset,
      weights.byteOffset + weights.byteLength
    )
    const spec = MODEL_ASSETS['hidden-light']
    expect(await sha256(jsonBuffer)).toBe(spec.jsonHash)
    expect(await sha256(weightBuffer)).toBe(spec.weightsHash)
    expect(weights.byteLength).toBe(spec.weightsBytes)
    expect(validateStoredModel(JSON.parse(json.toString('utf8')), weights.byteLength, spec)).toBe(
      true
    )
  })

  it('runs a small deterministic layers model and selects the highest class', async () => {
    const input = tf.input({ shape: [2, 2, 2, 1] })
    const convolution = tf.layers.conv3d({ filters: 3, kernelSize: 1, useBias: true })
    const output = convolution.apply(input)
    if (Array.isArray(output)) throw new Error('unexpected output')
    const model = tf.model({ inputs: input, outputs: output })
    convolution.setWeights([tf.zeros([1, 1, 1, 1, 3]), tf.tensor1d([0, 1, 2])])
    const progress: number[] = []
    try {
      const labels = await runModelHigh(model, new Uint8Array(8), [2, 2, 2], 0, 1, (completed) =>
        progress.push(completed)
      )
      expect(Array.from(labels)).toEqual(new Array(8).fill(2))
      expect(progress).toEqual([1])
    } finally {
      model.dispose()
    }
  })

  it('normalizes fixed-grid input before applying model layers', async () => {
    const input = tf.input({ shape: [1, 1, 2, 1] })
    const convolution = tf.layers.conv3d({ filters: 3, kernelSize: 1, useBias: true })
    const output = convolution.apply(input)
    if (Array.isArray(output)) throw new Error('unexpected output')
    const model = tf.model({ inputs: input, outputs: output })
    convolution.setWeights([tf.tensor5d([0, 1, 0], [1, 1, 1, 1, 3]), tf.tensor1d([0, 0, 0.5])])
    try {
      const labels = await runModelHigh(model, new Uint8Array([10, 20]), [1, 1, 2], 10, 0.1)
      expect(Array.from(labels)).toEqual([2, 1])
    } finally {
      model.dispose()
    }
  })

  it('matches high and low memory execution', async () => {
    const input = tf.input({ shape: [2, 2, 2, 1] })
    const first = tf.layers.conv3d({
      filters: 4,
      kernelSize: 3,
      padding: 'same',
      dilationRate: 2,
      useBias: true
    })
    const activated = tf.layers.activation({ activation: 'relu' }).apply(first.apply(input))
    const last = tf.layers.conv3d({ filters: 3, kernelSize: 1, padding: 'same', useBias: true })
    const output = last.apply(activated)
    if (Array.isArray(output)) throw new Error('unexpected output')
    const model = tf.model({ inputs: input, outputs: output })
    const values = new Uint8Array([0, 30, 60, 90, 120, 150, 180, 255])
    try {
      const beforeHigh = tf.memory().numTensors
      const high = await runModelHigh(model, values, [2, 2, 2], 0, 1 / 255)
      expect(tf.memory().numTensors).toBe(beforeHigh)
      const streamedProgress: Array<[number, number]> = []
      const streamed = await runModelHigh(
        model,
        values,
        [2, 2, 2],
        0,
        1 / 255,
        (completed, total) => streamedProgress.push([completed, total]),
        1
      )
      expect(tf.memory().numTensors).toBe(beforeHigh)
      const beforeLow = tf.memory().numTensors
      const low = await runModelLow(model, values, [2, 2, 2], 0, 1 / 255)
      expect(tf.memory().numTensors).toBe(beforeLow)
      expect(low).toEqual(high)
      expect(streamed).toEqual(high)
      expect(streamedProgress).toEqual([
        [1, 5],
        [2, 5],
        [3, 5],
        [4, 5],
        [5, 5]
      ])
    } finally {
      model.dispose()
    }
  })

  it('matches the fixed final-layer low-memory chunk rule', () => {
    expect(lowFinalInputChunkSize(3)).toBe(3)
    expect(lowFinalInputChunkSize(18)).toBe(10)
    expect(lowFinalInputChunkSize(104)).toBe(10)
  })

  it('streams a high-memory final layer only when its output exceeds the texture limit', () => {
    expect(highFinalNeedsStreaming([4, 4, 4], 4, 256)).toBe(false)
    expect(highFinalNeedsStreaming([4, 4, 4], 5, 256)).toBe(true)
    expect(highFinalNeedsStreaming([176, 144, 128], 104, 16_384 * 16_384)).toBe(true)
    expect(highFinalNeedsStreaming([176, 144, 128], 104, Number.POSITIVE_INFINITY)).toBe(false)
  })

  it('applies spatial channel normalization in both execution modes', async () => {
    const input = tf.input({ shape: [1, 1, 2, 1] })
    const normalized = tf.layers.conv3d({
      name: 'normalized_gn',
      filters: 1,
      kernelSize: 1,
      padding: 'same',
      useBias: true
    })
    const activated = tf.layers.activation({ activation: 'relu' }).apply(normalized.apply(input))
    const outputLayer = tf.layers.conv3d({
      filters: 2,
      kernelSize: 1,
      padding: 'same',
      useBias: true
    })
    const output = outputLayer.apply(activated)
    if (Array.isArray(output)) throw new Error('unexpected output')
    const model = tf.model({ inputs: input, outputs: output })
    normalized.setWeights([tf.tensor5d([1], [1, 1, 1, 1, 1]), tf.tensor1d([0])])
    outputLayer.setWeights([tf.tensor5d([0, 1], [1, 1, 1, 1, 2]), tf.tensor1d([2, 0])])
    try {
      const values = new Uint8Array([0, 10])
      expect(await runModelHigh(model, values, [1, 1, 2])).toEqual(new Uint8Array([0, 0]))
      expect(await runModelLow(model, values, [1, 1, 2])).toEqual(new Uint8Array([0, 0]))
    } finally {
      model.dispose()
    }
  })

  it('can execute the backend smoke test without leaking tensors', async () => {
    const before = tf.memory().numTensors
    await smokeTestBackend()
    expect(tf.memory().numTensors).toBe(before)
  })

  it('derives the stored-element cap from the active backend', () => {
    const gpuLimits = (
      maxBufferSize?: number,
      maxStorageBufferBindingSize?: number
    ): (() => unknown) => {
      return () => ({ device: { limits: { maxBufferSize, maxStorageBufferBindingSize } } })
    }
    // webgpu: the smaller of the two byte limits, converted to f32 elements.
    expect(currentMaxStoredElements(() => 'webgpu', gpuLimits(400, 100))).toBe(25)
    expect(currentMaxStoredElements(() => 'webgpu', gpuLimits(100, 400))).toBe(25)
    // webgpu with unreadable limits: the conservative 128 MiB fallback.
    expect(currentMaxStoredElements(() => 'webgpu', () => ({}))).toBe(33_554_432)
    // webgl: texture side squared; unreadable flag preserves the no-stream cap.
    expect(
      currentMaxStoredElements(
        () => 'webgl',
        () => ({}),
        () => 16_384
      )
    ).toBe(16_384 * 16_384)
    expect(
      currentMaxStoredElements(
        () => 'webgl',
        () => ({}),
        () => {
          throw new Error('no context')
        }
      )
    ).toBe(Number.POSITIVE_INFINITY)
  })

  it('classifies a flag-setup failure as unsupported without trying any candidate', async () => {
    const attempted: string[] = []
    const failure = initializeModelBackend(
      'webgpu',
      async (name) => {
        attempted.push(name)
        return true
      },
      async () => undefined,
      async () => undefined,
      () => {
        throw new Error('production mode failed')
      }
    )
    await expect(failure).rejects.toThrow('unsupported')
    expect(attempted).toEqual([])
  })

  it('reports unsupported only after every chain candidate fails', async () => {
    const attempted: string[] = []
    const failure = initializeModelBackend(
      'webgpu',
      async (name) => {
        attempted.push(name)
        return true
      },
      async () => undefined,
      async () => {
        throw new Error('context failed')
      }
    )
    await expect(failure).rejects.toThrow('unsupported')
    expect(attempted).toEqual(['webgpu', 'webgl'])
  })

  it('falls back to the other backend when the preferred one is unavailable', async () => {
    const chosen = await initializeModelBackend(
      'webgpu',
      async (name) => name === 'webgl',
      async () => undefined,
      async () => undefined
    )
    expect(chosen).toBe('webgl')
  })

  it('recovers when the preferred backend fails its smoke test', async () => {
    let active = ''
    const chosen = await initializeModelBackend(
      'webgpu',
      async (name) => {
        active = name
        return true
      },
      async () => undefined,
      async () => {
        if (active === 'webgpu') throw new Error('kernel missing')
      }
    )
    expect(chosen).toBe('webgl')
  })

  it('honors an explicit webgl preference before trying webgpu', async () => {
    const attempted: string[] = []
    const chosen = await initializeModelBackend(
      'webgl',
      async (name) => {
        attempted.push(name)
        return name === 'webgpu'
      },
      async () => undefined,
      async () => undefined
    )
    expect(chosen).toBe('webgpu')
    expect(attempted).toEqual(['webgl', 'webgpu'])
  })

  it('configures the fixed WebGL inference precision before readiness', async () => {
    const calls: string[] = []
    await initializeModelBackend(
      'webgpu',
      async (name) => {
        calls.push(`backend:${name}`)
        return true
      },
      async () => {
        calls.push('ready')
      },
      async () => {
        calls.push('smoke')
      },
      () => {
        calls.push('production')
      },
      (name, value) => {
        calls.push(`${name}:${value}`)
      }
    )
    expect(calls).toEqual([
      'production',
      'DEBUG:false',
      'WEBGL_FORCE_F16_TEXTURES:true',
      'WEBGL_DELETE_TEXTURE_THRESHOLD:-1',
      'backend:webgpu',
      'ready',
      'smoke'
    ])
  })
})
