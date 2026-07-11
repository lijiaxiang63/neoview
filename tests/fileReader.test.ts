import { describe, expect, it, vi } from 'vitest'
import { createFileReader, MAX_FILE_BYTES } from '../src/main/files/reader'

describe('file reader', () => {
  it('rejects a file over the global limit before reading any bytes', async () => {
    const readFile = vi.fn(async () => new Uint8Array([1]))
    const reader = createFileReader({
      stat: async () => ({ size: MAX_FILE_BYTES + 1 }),
      readFile
    })

    await expect(reader.read('/root/large.nii')).rejects.toThrow('larger than 2 GB')
    expect(readFile).not.toHaveBeenCalled()
  })

  it('applies the caller limit before a prefetch read and clamps it globally', async () => {
    const readFile = vi.fn(async () => new Uint8Array([1, 2, 3]))
    const reader = createFileReader({
      stat: async () => ({ size: 11 }),
      readFile
    })

    await expect(reader.readWithin('/real/a.nii', 10, '/shown/a.nii')).resolves.toBeNull()
    expect(readFile).not.toHaveBeenCalled()

    const opened = await reader.readWithin('/real/a.nii', 11, '/shown/a.nii')
    expect(opened).toMatchObject({ name: 'a.nii', path: '/shown/a.nii' })
    expect([...new Uint8Array(opened!.bytes)]).toEqual([1, 2, 3])
  })

  it('copies only the exact byte view into the transferable payload', async () => {
    const backing = new Uint8Array([9, 1, 2, 8])
    const reader = createFileReader({
      stat: async () => ({ size: 2 }),
      readFile: async () => backing.subarray(1, 3)
    })

    const opened = await reader.read('/real/source.nii', '/shown/source.nii')
    expect(opened.path).toBe('/shown/source.nii')
    expect(opened.bytes.byteLength).toBe(2)
    expect([...new Uint8Array(opened.bytes)]).toEqual([1, 2])
  })

  it('forwards cancellation to the byte read and rejects a pre-cancelled request early', async () => {
    const active = new AbortController()
    let receivedSignal: AbortSignal | undefined
    const readFile = vi.fn(
      (_path: string, signal?: AbortSignal): Promise<Uint8Array> =>
        new Promise((_resolve, reject) => {
          receivedSignal = signal
          const onAbort = (): void => reject(signal?.reason)
          if (signal?.aborted) onAbort()
          else signal?.addEventListener('abort', onAbort, { once: true })
        })
    )
    const stat = vi.fn(async () => ({ size: 1 }))
    const reader = createFileReader({ stat, readFile })
    const pending = reader.read('/root/a.nii', '/root/a.nii', active.signal)
    await vi.waitFor(() => expect(readFile).toHaveBeenCalledTimes(1))

    active.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(receivedSignal).toBe(active.signal)

    const preCancelled = new AbortController()
    preCancelled.abort()
    await expect(
      reader.read('/root/b.nii', '/root/b.nii', preCancelled.signal)
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(stat).toHaveBeenCalledTimes(1)
  })
})
