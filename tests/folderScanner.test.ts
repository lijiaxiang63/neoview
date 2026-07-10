import { describe, expect, it } from 'vitest'
import { createFolderScanner, type DirectoryEntry } from '../src/main/files/scanner'

type Kind = 'directory' | 'file' | 'link'

function entry(name: string, kind: Kind): DirectoryEntry {
  return {
    name,
    isDirectory: () => kind === 'directory',
    isFile: () => kind === 'file',
    isSymbolicLink: () => kind === 'link'
  }
}

describe('folder scanner', () => {
  it('streams non-overlapping batches and returns the complete result', async () => {
    const scanner = createFolderScanner(
      {
        readdir: async () => [entry('a.nii', 'file'), entry('b.nii.gz', 'file')],
        now: (() => {
          let value = 0
          return () => ++value
        })()
      },
      { concurrency: 1, batchMs: 0 }
    )
    const batches: string[][] = []

    const result = await scanner.scan('/root', (files) =>
      batches.push(files.map((file) => file.name))
    )

    expect(batches.flat()).toEqual(['a.nii', 'b.nii.gz'])
    expect(result.files.map((file) => file.name)).toEqual(['a.nii', 'b.nii.gz'])
    expect(result.truncated).toBe(false)
  })

  it('does not descend beyond the configured depth', async () => {
    const reads: string[] = []
    const tree = new Map<string, DirectoryEntry[]>([
      ['/root', [entry('one', 'directory'), entry('root.nii', 'file')]],
      ['/root/one', [entry('two', 'directory'), entry('one.nii', 'file')]],
      ['/root/one/two', [entry('too-deep.nii', 'file')]]
    ])
    const scanner = createFolderScanner(
      {
        readdir: async (path) => {
          reads.push(path)
          return tree.get(path) ?? []
        }
      },
      { maxDepth: 1, concurrency: 1 }
    )

    const result = await scanner.scan('/root')

    expect(result.files.map((file) => file.name)).toEqual(['root.nii', 'one.nii'])
    expect(reads).not.toContain('/root/one/two')
  })

  it('enforces separate file and product limits and reports truncation', async () => {
    const scanner = createFolderScanner(
      {
        readdir: async () => [
          entry('a.regions.nii.gz', 'file'),
          entry('b.mask.nii', 'file'),
          entry('c.regions.nii', 'file'),
          entry('a.nii', 'file'),
          entry('b.nii', 'file'),
          entry('c.nii', 'file')
        ]
      },
      { maxFiles: 2, concurrency: 1 }
    )

    const result = await scanner.scan('/root')

    expect(result.files.map((file) => file.name)).toEqual([
      'a.regions.nii.gz',
      'b.mask.nii',
      'a.nii',
      'b.nii'
    ])
    expect(result.truncated).toBe(true)
  })

  it('keeps results from readable branches when a child cannot be read', async () => {
    const scanner = createFolderScanner(
      {
        readdir: async (path) => {
          if (path === '/root') {
            return [entry('good', 'directory'), entry('blocked', 'directory')]
          }
          if (path === '/root/blocked') throw new Error('denied')
          return [entry('kept.nii', 'file')]
        }
      },
      { concurrency: 2 }
    )

    const result = await scanner.scan('/root')

    expect(result.files).toEqual([
      { name: 'kept.nii', path: '/root/good/kept.nii', relDir: 'good' }
    ])
    expect(result.truncated).toBe(false)
  })

  it('stops scheduling directory reads after the caller cancels', async () => {
    const reads: string[] = []
    let current = true
    const scanner = createFolderScanner(
      {
        readdir: async (path) => {
          reads.push(path)
          if (path === '/root') {
            current = false
            return [entry('one', 'directory'), entry('two', 'directory')]
          }
          return [entry('late.nii', 'file')]
        }
      },
      { concurrency: 1 }
    )

    const result = await scanner.scan('/root', undefined, () => current)

    expect(reads).toEqual(['/root'])
    expect(result.files).toEqual([])
  })

  it('bounds directory traversal independently of the file limit', async () => {
    const reads: string[] = []
    const scanner = createFolderScanner(
      {
        readdir: async (path) => {
          reads.push(path)
          return path === '/root'
            ? Array.from({ length: 8 }, (_, index) => entry(`d${index}`, 'directory'))
            : []
        }
      },
      { concurrency: 1, maxDirectories: 3 }
    )

    const result = await scanner.scan('/root')

    expect(reads).toHaveLength(3)
    expect(result.truncated).toBe(true)
  })

  it('rejects when a streamed batch callback throws', async () => {
    const scanner = createFolderScanner(
      { readdir: async () => [entry('a.nii', 'file')] },
      { batchMs: 0 }
    )

    await expect(
      scanner.scan('/root', () => {
        throw new Error('send failed')
      })
    ).rejects.toThrow('send failed')
  })
})
