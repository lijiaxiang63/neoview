import type { OpenedFile } from '../../shared/files'

export const MAX_FILE_BYTES = 2 * 1024 ** 3

export interface FileReaderDependencies {
  stat(path: string): Promise<{ size: number }>
  readFile(path: string): Promise<Uint8Array>
}

export interface FileReader {
  /** Read sourcePath while preserving openedPath as the renderer-visible identity. */
  read(sourcePath: string, openedPath?: string): Promise<OpenedFile>
  /** Return null without reading when the file is over the caller's bounded limit. */
  readWithin(sourcePath: string, maxBytes: number, openedPath?: string): Promise<OpenedFile | null>
  /** Read a bundled asset under an explicit display name and path identity. */
  readNamed(sourcePath: string, name: string, openedPath?: string): Promise<OpenedFile>
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

export function createFileReader(deps: FileReaderDependencies): FileReader {
  const readBytes = async (sourcePath: string): Promise<ArrayBuffer> =>
    exactArrayBuffer(await deps.readFile(sourcePath))

  return {
    async read(sourcePath, openedPath = sourcePath) {
      const stat = await deps.stat(sourcePath)
      if (stat.size > MAX_FILE_BYTES) {
        throw new Error('File is larger than 2 GB, which is not supported.')
      }
      return { name: fileName(openedPath), path: openedPath, bytes: await readBytes(sourcePath) }
    },

    async readWithin(sourcePath, maxBytes, openedPath = sourcePath) {
      const limit =
        typeof maxBytes === 'number' && Number.isFinite(maxBytes)
          ? Math.min(Math.max(maxBytes, 0), MAX_FILE_BYTES)
          : 0
      const stat = await deps.stat(sourcePath)
      if (stat.size > limit) return null
      return { name: fileName(openedPath), path: openedPath, bytes: await readBytes(sourcePath) }
    },

    async readNamed(sourcePath, name, openedPath = '') {
      return { name, path: openedPath, bytes: await readBytes(sourcePath) }
    }
  }
}
