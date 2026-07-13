import { describe, expect, it, vi } from 'vitest'
import { AtlasProvider } from '../src/renderer/src/runtime/atlasProvider'
import { allocateFileReadRequestId } from '../src/renderer/src/runtime/fileReadRequestIds'

describe('AtlasProvider', () => {
  it('allocates from the shared file-read request namespace', async () => {
    const before = allocateFileReadRequestId()
    const ids: number[] = []
    const provider = new AtlasProvider({
      readAtlas: async (requestId) => {
        ids.push(requestId)
        return null
      }
    })

    await expect(provider.get('aal3')).resolves.toBeNull()
    const after = allocateFileReadRequestId()

    expect(ids).toEqual([before + 1])
    expect(after).toBe(ids[0] + 1)
    provider.dispose()
  })

  it('cancels a pending main-side read on disposal', async () => {
    let resolveRead!: (value: null) => void
    let requestId = 0
    const cancelFileRead = vi.fn()
    const provider = new AtlasProvider({
      readAtlas: (id) => {
        requestId = id
        return new Promise((resolve) => {
          resolveRead = resolve
        })
      },
      cancelFileRead
    })

    const pending = provider.get('aal3')
    provider.dispose()
    expect(cancelFileRead).toHaveBeenCalledWith(requestId)
    resolveRead(null)
    await expect(pending).resolves.toBeNull()
  })
})
