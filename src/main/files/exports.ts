import { join } from 'path'
import type { ExportRequest, ExportResult } from '../../shared/files'

export interface ExclusiveExportFile {
  write(contents: Uint8Array | string): Promise<void>
  close(): Promise<void>
}

export interface ExportDependencies {
  stat(path: string): Promise<{ isDirectory(): boolean }>
  /** Atomically reserves a previously absent path or rejects with EEXIST. */
  openExclusive(path: string): Promise<ExclusiveExportFile>
  remove(path: string): Promise<void>
}

export interface ExportService {
  write(request: ExportRequest): Promise<ExportResult>
}

export function splitExportName(fileName: string): { stem: string; ext: string } {
  const match = /\.(nii\.gz|nii|txt)$/i.exec(fileName)
  if (!match) return { stem: fileName, ext: '' }
  return { stem: fileName.slice(0, match.index), ext: match[0] }
}

function isCollision(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'
}

export function createExportService(deps: ExportDependencies): ExportService {
  // Serializing app-originated requests avoids needless suffix retries; the
  // exclusive reservations below remain the authority against external races.
  let writeQueue: Promise<void> = Promise.resolve()

  const cleanupOwned = async (file: ExclusiveExportFile | null, path: string): Promise<void> => {
    await file?.close().catch(() => undefined)
    await deps.remove(path)
  }

  const writeRequest = async (request: ExportRequest): Promise<ExportResult> => {
    const dir = request.dir
    if (!(await deps.stat(dir).catch(() => null))?.isDirectory()) {
      throw new Error(`Export folder does not exist: ${dir}`)
    }
    if (
      request.fileName === '' ||
      /[\\/]/.test(request.fileName) ||
      (request.sidecar !== null &&
        (request.sidecar.fileName === '' || /[\\/]/.test(request.sidecar.fileName)))
    ) {
      throw new Error('Invalid export file name.')
    }

    const main = splitExportName(request.fileName)
    const sidecarExt = request.sidecar
      ? splitExportName(request.sidecar.fileName).ext || '.txt'
      : null
    if (sidecarExt !== null && main.ext.toLowerCase() === sidecarExt.toLowerCase()) {
      throw new Error('Invalid export file name.')
    }

    for (let n = 0; ; n++) {
      const chosenStem = n === 0 ? main.stem : `${main.stem}-${n}`
      const path = join(dir, `${chosenStem}${main.ext}`)
      const sidecarPath = sidecarExt === null ? null : join(dir, `${chosenStem}${sidecarExt}`)
      let mainFile: ExclusiveExportFile | null = null
      let sidecarFile: ExclusiveExportFile | null = null

      try {
        mainFile = await deps.openExclusive(path)
      } catch (error) {
        if (isCollision(error)) continue
        throw error
      }

      if (sidecarPath) {
        try {
          sidecarFile = await deps.openExclusive(sidecarPath)
        } catch (error) {
          await cleanupOwned(mainFile, path)
          mainFile = null
          if (isCollision(error)) continue
          throw error
        }
      }

      try {
        await mainFile.write(new Uint8Array(request.bytes))
        if (request.sidecar && sidecarFile) await sidecarFile.write(request.sidecar.text)
        await mainFile.close()
        mainFile = null
        if (sidecarFile) {
          await sidecarFile.close()
          sidecarFile = null
        }
        return { path, sidecarPath }
      } catch (error) {
        const cleanup = await Promise.allSettled([
          cleanupOwned(mainFile, path),
          ...(sidecarPath ? [cleanupOwned(sidecarFile, sidecarPath)] : [])
        ])
        const cleanupErrors = cleanup
          .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .map((result) => result.reason)
        if (cleanupErrors.length > 0) {
          throw new AggregateError(
            [error, ...cleanupErrors],
            'Export failed and partial output could not be removed.'
          )
        }
        throw error
      }
    }
  }

  return {
    write(request) {
      const result = writeQueue.then(() => writeRequest(request))
      writeQueue = result.then(
        () => undefined,
        () => undefined
      )
      return result
    }
  }
}
