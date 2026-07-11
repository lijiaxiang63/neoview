import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_SHARED_RAW_BYTES,
  sharedRawEligible,
  shareVolumeRaw
} from '../src/renderer/src/volume/sharedRaw'
import type { Volume } from '../src/renderer/src/volume/types'

afterEach(() => vi.unstubAllGlobals())

describe('shared raw storage', () => {
  it('copies only the exact typed sample span and preserves its constructor', () => {
    vi.stubGlobal('crossOriginIsolated', true)
    const source = new ArrayBuffer(12)
    new Int16Array(source).set([90, 91, 4, 5, 6, 92])
    const volume = {
      raw: new Int16Array(source, 4, 3)
    } as Volume

    expect(shareVolumeRaw(volume)).toBe(true)
    expect(volume.raw).toBeInstanceOf(Int16Array)
    expect(Array.from(volume.raw)).toEqual([4, 5, 6])
    expect(volume.raw.byteOffset).toBe(0)
    expect(volume.raw.buffer).toBeInstanceOf(SharedArrayBuffer)
    expect(volume.raw.buffer.byteLength).toBe(3 * Int16Array.BYTES_PER_ELEMENT)
  })

  it('requires deployed isolation and enforces the bounded extra-copy budget', () => {
    vi.stubGlobal('crossOriginIsolated', false)
    expect(sharedRawEligible(8)).toBe(false)

    vi.stubGlobal('crossOriginIsolated', true)
    expect(sharedRawEligible(MAX_SHARED_RAW_BYTES)).toBe(true)
    expect(sharedRawEligible(MAX_SHARED_RAW_BYTES + 1)).toBe(false)
    expect(
      shareVolumeRaw({ raw: { byteLength: MAX_SHARED_RAW_BYTES + 1 } } as unknown as Volume)
    ).toBe(false)
  })
})
