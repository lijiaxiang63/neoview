import { join } from 'path'
import type { FolderEntry, FolderScan } from '../../shared/files'
import { isRegionExportFileName, isVolumeFileName } from './names'

export const SCAN_DEPTH_MAX = 8
export const SCAN_FILES_MAX = 2000
export const SCAN_CONCURRENCY = 16
export const SCAN_BATCH_MS = 200

export interface DirectoryEntry {
  name: string
  isDirectory(): boolean
  isFile(): boolean
  isSymbolicLink(): boolean
}

export interface FolderScannerDependencies {
  readdir(path: string): Promise<readonly DirectoryEntry[]>
  now?: () => number
}

export interface FolderScannerOptions {
  maxDepth?: number
  maxFiles?: number
  concurrency?: number
  batchMs?: number
}

export interface FolderScanner {
  scan(root: string, onBatch?: (files: FolderEntry[]) => void): Promise<FolderScan>
}

/** Recursive scanner with bounded traversal and independently budgeted products. */
export function createFolderScanner(
  deps: FolderScannerDependencies,
  options: FolderScannerOptions = {}
): FolderScanner {
  const maxDepth = options.maxDepth ?? SCAN_DEPTH_MAX
  const maxFiles = options.maxFiles ?? SCAN_FILES_MAX
  const concurrency = Math.max(1, options.concurrency ?? SCAN_CONCURRENCY)
  const batchMs = Math.max(0, options.batchMs ?? SCAN_BATCH_MS)
  const now = deps.now ?? Date.now

  return {
    async scan(root, onBatch) {
      const files: FolderEntry[] = []
      let sent = 0
      let lastFlush = 0
      const maybeFlush = (): void => {
        if (!onBatch || sent >= files.length || now() - lastFlush < batchMs) return
        onBatch(files.slice(sent))
        sent = files.length
        lastFlush = now()
      }

      let truncated = false
      let stopped = false
      let plainCount = 0
      let productCount = 0
      const pending: Array<{ dir: string; relDir: string; depth: number }> = [
        { dir: root, relDir: '', depth: 0 }
      ]

      const processDirectory = async (item: {
        dir: string
        relDir: string
        depth: number
      }): Promise<void> => {
        // An unreadable child directory does not invalidate files found elsewhere.
        const entries = await deps.readdir(item.dir).catch(() => [])
        for (const entry of entries) {
          if (stopped) return
          if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
          if (entry.isDirectory()) {
            if (item.depth < maxDepth) {
              pending.push({
                dir: join(item.dir, entry.name),
                relDir: item.relDir ? `${item.relDir}/${entry.name}` : entry.name,
                depth: item.depth + 1
              })
            }
          } else if (entry.isFile() && isVolumeFileName(entry.name)) {
            if (isRegionExportFileName(entry.name)) {
              if (productCount >= maxFiles) {
                truncated = true
                continue
              }
              productCount++
            } else {
              if (plainCount >= maxFiles) {
                truncated = true
                stopped = true
                return
              }
              plainCount++
            }
            files.push({ name: entry.name, path: join(item.dir, entry.name), relDir: item.relDir })
            maybeFlush()
          }
        }
      }

      await new Promise<void>((resolveDone) => {
        let active = 0
        const pump = (): void => {
          if (stopped) pending.length = 0
          if (pending.length === 0 && active === 0) {
            resolveDone()
            return
          }
          while (active < concurrency && pending.length > 0) {
            const item = pending.shift()
            if (!item) break
            active++
            void processDirectory(item).finally(() => {
              active--
              pump()
            })
          }
        }
        pump()
      })

      return { root, files, truncated }
    }
  }
}
