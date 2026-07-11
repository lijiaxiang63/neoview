import type { Volume, VoxelArray } from './types'

/** Bound the one-time shared copy while the parsed source buffer and initial
 * texture staging are still live in the load worker. Larger inputs keep the
 * raw buffer unshared and derive only bounded texture output cooperatively. */
export const MAX_SHARED_RAW_BYTES = 128 * 1024 * 1024

export function sharedRawEligible(byteLength: number): boolean {
  return (
    globalThis.crossOriginIsolated === true &&
    typeof SharedArrayBuffer !== 'undefined' &&
    Number.isSafeInteger(byteLength) &&
    byteLength >= 0 &&
    byteLength <= MAX_SHARED_RAW_BYTES
  )
}

/** Replace the exact raw sample span with shared storage so the renderer and
 * retained load worker can read one allocation without transferring/copying
 * whole frames on each request. */
export function shareVolumeRaw(volume: Volume): boolean {
  if (!sharedRawEligible(volume.raw.byteLength)) return false
  try {
    const source = new Uint8Array(volume.raw.buffer, volume.raw.byteOffset, volume.raw.byteLength)
    const buffer = new SharedArrayBuffer(source.byteLength)
    new Uint8Array(buffer).set(source)
    const Ctor = volume.raw.constructor as new (buffer: ArrayBufferLike) => VoxelArray
    volume.raw = new Ctor(buffer)
    return true
  } catch {
    return false
  }
}
