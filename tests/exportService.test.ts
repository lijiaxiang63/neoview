import { access, mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { createExportService, type ExportService } from '../src/main/files/exports'

const tempDirs: string[] = []

async function tempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'neoview-export-'))
  tempDirs.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function service(): ExportService {
  return createExportService({
    stat,
    access,
    writeBytes: (path, bytes) => writeFile(path, bytes),
    writeText: (path, text) => writeFile(path, text, 'utf8')
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
    await expect(access(join(dir, 'escape.nii'))).rejects.toBeTruthy()
  })
})
