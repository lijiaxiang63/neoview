import { afterEach, describe, expect, it, vi } from 'vitest'
import { PreviewClient } from '../src/renderer/src/segmentation/previewClient'
import type { Volume } from '../src/renderer/src/volume/types'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('PreviewClient lifecycle', () => {
  it('dispose terminates its lazily-created worker and is idempotent', () => {
    const worker = {
      onmessage: null,
      onerror: null,
      postMessage: vi.fn(),
      terminate: vi.fn()
    }
    vi.stubGlobal(
      'Worker',
      class {
        onmessage = worker.onmessage
        onerror = worker.onerror
        postMessage = worker.postMessage
        terminate = worker.terminate
      }
    )
    const client = new PreviewClient()
    const volume = {
      dims: [1, 1, 1],
      frames: 1,
      raw: new Uint8Array([1]),
      slope: 1,
      inter: 0,
      affine: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    } as unknown as Volume

    expect(
      client.request(
        volume,
        null,
        0,
        [],
        {
          token: 1,
          box: { min: [0, 0, 0], max: [0, 0, 0] },
          bounds: { min: [0, 0, 0], max: [0, 0, 0] },
          params: {
            low: 0,
            high: 0,
            connectivity: 6,
            minVoxels: 1,
            maxVoxels: Infinity
          },
          frameOffset: 0,
          frame: 0,
          constraint: { type: 'none' }
        },
        vi.fn()
      )
    ).toBe(true)

    client.dispose()
    client.dispose()
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })
})
