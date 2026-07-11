import type { OpenedFile } from '../../shared/files'

export const MAX_FILE_BYTES = 2 * 1024 ** 3

export interface FileReaderDependencies {
  stat(path: string): Promise<{ size: number }>
  readFile(path: string, signal?: AbortSignal): Promise<Uint8Array>
}

export interface FileReader {
  /** Read sourcePath while preserving openedPath as the renderer-visible identity. */
  read(sourcePath: string, openedPath?: string, signal?: AbortSignal): Promise<OpenedFile>
  /** Return null without reading when the file is over the caller's bounded limit. */
  readWithin(
    sourcePath: string,
    maxBytes: number,
    openedPath?: string,
    signal?: AbortSignal
  ): Promise<OpenedFile | null>
  /** Read a bundled asset under an explicit display name and path identity. */
  readNamed(
    sourcePath: string,
    name: string,
    openedPath?: string,
    signal?: AbortSignal
  ): Promise<OpenedFile>
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  if (signal.reason instanceof Error) throw signal.reason
  const error = new Error('File read cancelled.')
  error.name = 'AbortError'
  throw error
}

export function createFileReader(deps: FileReaderDependencies): FileReader {
  const readBytes = async (sourcePath: string, signal?: AbortSignal): Promise<ArrayBuffer> => {
    throwIfAborted(signal)
    const bytes = await deps.readFile(sourcePath, signal)
    throwIfAborted(signal)
    return exactArrayBuffer(bytes)
  }

  return {
    async read(sourcePath, openedPath = sourcePath, signal) {
      throwIfAborted(signal)
      const stat = await deps.stat(sourcePath)
      throwIfAborted(signal)
      if (stat.size > MAX_FILE_BYTES) {
        throw new Error('File is larger than 2 GB, which is not supported.')
      }
      return {
        name: fileName(openedPath),
        path: openedPath,
        bytes: await readBytes(sourcePath, signal)
      }
    },

    async readWithin(sourcePath, maxBytes, openedPath = sourcePath, signal) {
      throwIfAborted(signal)
      const limit =
        typeof maxBytes === 'number' && Number.isFinite(maxBytes)
          ? Math.min(Math.max(maxBytes, 0), MAX_FILE_BYTES)
          : 0
      const stat = await deps.stat(sourcePath)
      throwIfAborted(signal)
      if (stat.size > limit) return null
      return {
        name: fileName(openedPath),
        path: openedPath,
        bytes: await readBytes(sourcePath, signal)
      }
    },

    async readNamed(sourcePath, name, openedPath = '', signal) {
      return { name, path: openedPath, bytes: await readBytes(sourcePath, signal) }
    }
  }
}
