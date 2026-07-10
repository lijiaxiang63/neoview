import { join } from 'path'
import type { ExportRequest, ExportResult } from '../../shared/files'

export interface ExportDependencies {
  stat(path: string): Promise<{ isDirectory(): boolean }>
  access(path: string): Promise<void>
  writeBytes(path: string, bytes: Uint8Array): Promise<void>
  writeText(path: string, text: string): Promise<void>
}

export interface ExportService {
  uniquePath(dir: string, fileName: string): Promise<string>
  write(request: ExportRequest): Promise<ExportResult>
}

export function splitExportName(fileName: string): { stem: string; ext: string } {
  const match = /\.(nii\.gz|nii|gz|txt)$/i.exec(fileName)
  if (!match) return { stem: fileName, ext: '' }
  return { stem: fileName.slice(0, match.index), ext: match[0] }
}

export function createExportService(deps: ExportDependencies): ExportService {
  const uniquePath = async (dir: string, fileName: string): Promise<string> => {
    const { stem, ext } = splitExportName(fileName)
    for (let n = 0; ; n++) {
      const candidate = join(dir, n === 0 ? `${stem}${ext}` : `${stem}-${n}${ext}`)
      try {
        await deps.access(candidate)
      } catch {
        return candidate
      }
    }
  }

  return {
    uniquePath,

    async write(request) {
      const dir = request.dir
      if (!(await deps.stat(dir).catch(() => null))?.isDirectory()) {
        throw new Error(`Export folder does not exist: ${dir}`)
      }
      if (
        /[\\/]/.test(request.fileName) ||
        (request.sidecar !== null && /[\\/]/.test(request.sidecar.fileName))
      ) {
        throw new Error('Invalid export file name.')
      }

      const path = await uniquePath(dir, request.fileName)
      await deps.writeBytes(path, new Uint8Array(request.bytes))
      let sidecarPath: string | null = null
      if (request.sidecar) {
        const chosenName = path.split(/[\\/]/).pop() ?? ''
        const chosenStem = splitExportName(chosenName).stem
        const sidecarExt = splitExportName(request.sidecar.fileName).ext || '.txt'
        sidecarPath = await uniquePath(dir, `${chosenStem}${sidecarExt}`)
        await deps.writeText(sidecarPath, request.sidecar.text)
      }
      return { path, sidecarPath }
    }
  }
}
