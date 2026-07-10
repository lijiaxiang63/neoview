import { mkdtemp, open, readFile, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createExportService,
  type ExclusiveExportFile,
  type ExportService
} from '../src/main/files/exports'

const tempDirs: string[] = []

async function tempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'neoview-export-'))
  tempDirs.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function collision(): Error & { code: string } {
  return Object.assign(new Error('exists'), { code: 'EEXIST' })
}

function service(): ExportService {
  return createExportService({
    stat,
    openExclusive: async (path) => {
      const file = await open(path, 'wx')
      return {
        write: (contents) =>
          typeof contents === 'string'
            ? file.writeFile(contents, { encoding: 'utf8' })
            : file.writeFile(contents),
        close: () => file.close()
      }
    },
    remove: (path) => rm(path, { force: true })
  })
}

function memoryService(
  files: Map<string, string>,
  options: {
    beforeOpen?: (path: string) => void
    openError?: (path: string) => unknown
    writeError?: (path: string) => unknown
  } = {}
): ExportService {
  return createExportService({
    stat: async () => ({ isDirectory: () => true }),
    openExclusive: async (path) => {
      options.beforeOpen?.(path)
      const openError = options.openError?.(path)
      if (openError) throw openError
      if (files.has(path)) throw collision()
      files.set(path, '')
      return {
        write: async (contents) => {
          const writeError = options.writeError?.(path)
          if (writeError) throw writeError
          files.set(path, typeof contents === 'string' ? contents : 'bytes')
        },
        close: async () => undefined
      } satisfies ExclusiveExportFile
    },
    remove: async (path) => void files.delete(path)
  })
}

describe('export service', () => {
  it('applies the collision suffix to the main file and its companion', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'sample.regions.nii.gz'), 'old')
    await writeFile(join(dir, 'sample.regions-1.nii.gz'), 'old')

    const result = await service().write({
      dir,
      fileName: 'sample.regions.nii.gz',
      bytes: new Uint8Array([1, 2, 3]).buffer,
      sidecar: { fileName: 'sample.regions.txt', text: 'table' }
    })

    expect(result.path).toBe(join(dir, 'sample.regions-2.nii.gz'))
    expect(result.sidecarPath).toBe(join(dir, 'sample.regions-2.txt'))
    expect([...(await readFile(result.path))]).toEqual([1, 2, 3])
    expect(await readFile(result.sidecarPath!, 'utf8')).toBe('table')
  })

  it('chooses one collision suffix that is free for both output files', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'sample.regions.nii.gz'), 'old')
    await writeFile(join(dir, 'sample.regions-1.nii.gz'), 'old')
    await writeFile(join(dir, 'sample.regions-2.txt'), 'old')

    const result = await service().write({
      dir,
      fileName: 'sample.regions.nii.gz',
      bytes: new Uint8Array([1]).buffer,
      sidecar: { fileName: 'sample.regions.txt', text: 'table' }
    })

    expect(result.path).toBe(join(dir, 'sample.regions-3.nii.gz'))
    expect(result.sidecarPath).toBe(join(dir, 'sample.regions-3.txt'))
  })

  it('rejects path-like output names before writing', async () => {
    const dir = await tempDir()
    await expect(
      service().write({
        dir,
        fileName: '../escape.nii',
        bytes: new ArrayBuffer(0),
        sidecar: null
      })
    ).rejects.toThrow('Invalid export file name')
  })

  it('rejects a companion extension that would overwrite the main output', async () => {
    const dir = await tempDir()
    await expect(
      service().write({
        dir,
        fileName: 'sample.regions.nii',
        bytes: new ArrayBuffer(1),
        sidecar: { fileName: 'sample.colors.nii', text: 'table' }
      })
    ).rejects.toThrow('Invalid export file name')
  })

  it('removes both owned paths when the companion write fails', async () => {
    const files = new Map<string, string>()
    const exporter = memoryService(files, {
      writeError: (path) => (path.endsWith('.txt') ? new Error('write failed') : undefined)
    })

    await expect(
      exporter.write({
        dir: '/export',
        fileName: 'sample.regions.nii',
        bytes: new ArrayBuffer(1),
        sidecar: { fileName: 'sample.regions.txt', text: 'table' }
      })
    ).rejects.toThrow('write failed')

    expect(files).toEqual(new Map())
  })

  it('serializes concurrent writes so collision suffixes stay unique', async () => {
    const dir = await tempDir()
    const exporter = service()
    const request = {
      dir,
      fileName: 'sample.mask.nii',
      bytes: new Uint8Array([1]).buffer,
      sidecar: null
    }

    const [first, second] = await Promise.all([exporter.write(request), exporter.write(request)])

    expect(new Set([first.path, second.path])).toEqual(
      new Set([join(dir, 'sample.mask.nii'), join(dir, 'sample.mask-1.nii')])
    )
  })

  it('retries an exclusive collision without overwriting or deleting the foreign file', async () => {
    const files = new Map<string, string>()
    let raced = false
    const exporter = memoryService(files, {
      beforeOpen: (path) => {
        if (!raced) {
          raced = true
          files.set(path, 'foreign')
        }
      }
    })

    const result = await exporter.write({
      dir: '/export',
      fileName: 'sample.mask.nii',
      bytes: new ArrayBuffer(1),
      sidecar: null
    })

    expect(files.get('/export/sample.mask.nii')).toBe('foreign')
    expect(files.get('/export/sample.mask-1.nii')).toBe('bytes')
    expect(result.path).toBe('/export/sample.mask-1.nii')
  })

  it('propagates non-collision open errors without writing or removing', async () => {
    const files = new Map<string, string>()
    const exporter = memoryService(files, {
      openError: () => Object.assign(new Error('denied'), { code: 'EACCES' })
    })

    await expect(
      exporter.write({
        dir: '/export',
        fileName: 'sample.mask.nii',
        bytes: new ArrayBuffer(1),
        sidecar: null
      })
    ).rejects.toThrow('denied')
    expect(files).toEqual(new Map())
  })

  it('removes an owned partially written main file when writing rejects', async () => {
    const files = new Map<string, string>()
    const exporter = memoryService(files, { writeError: () => new Error('write failed') })

    await expect(
      exporter.write({
        dir: '/export',
        fileName: 'sample.mask.nii',
        bytes: new ArrayBuffer(1),
        sidecar: null
      })
    ).rejects.toThrow('write failed')

    expect(files).toEqual(new Map())
  })
})
