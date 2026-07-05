export const MAX_BYTES = 2 * 1024 ** 3

export function isGzip(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 2) return false
  const b = new Uint8Array(buf, 0, 2)
  return b[0] === 0x1f && b[1] === 0x8b
}

/**
 * The gzip trailer's last 4 bytes hold the uncompressed size mod 2^32.
 * Trusting it (with a fallback) lets us inflate straight into one
 * preallocated buffer instead of accumulating chunks and re-copying —
 * a large-fraction-of-a-GB copy saved on big volumes.
 */
function trailerSize(buf: ArrayBuffer): number {
  if (buf.byteLength < 18) return 0
  return new DataView(buf, buf.byteLength - 4, 4).getUint32(0, true)
}

/** Inflate a gzip buffer, aborting once the output exceeds MAX_BYTES. */
export async function gunzip(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))
  const reader = stream.getReader()
  const hinted = trailerSize(buf)
  let direct = hinted > 0 && hinted <= MAX_BYTES ? new Uint8Array(hinted) : null
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const end = total + value.byteLength
      if (end > MAX_BYTES) {
        await reader.cancel()
        throw new Error('Decompressed data is larger than 2 GB, which is not supported.')
      }
      if (direct) {
        if (end <= direct.length) {
          direct.set(value, total)
        } else {
          // Trailer lied (multi-member archive) — fall back to chunk mode.
          chunks.push(direct.subarray(0, total).slice(), value)
          direct = null
        }
      } else {
        chunks.push(value)
      }
      total = end
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('2 GB')) throw err
    throw new Error('Could not decompress file.')
  }
  if (direct) {
    return total === direct.length ? direct.buffer : direct.buffer.slice(0, total)
  }
  const out = new Uint8Array(total)
  let pos = 0
  for (const chunk of chunks) {
    out.set(chunk, pos)
    pos += chunk.byteLength
  }
  return out.buffer
}
