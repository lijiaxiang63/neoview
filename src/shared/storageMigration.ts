/** Keys that lived under the packaged renderer's former file origin. */
export const PERSISTED_STORAGE_KEYS = [
  'neoview.viewPrefs.v1',
  'neoview.export.format',
  'neoview.export.dir'
] as const

export const STORAGE_ORIGIN_MARKER = 'neoview.storageOrigin.v1'
export const STORAGE_MIGRATION_QUERY = 'storage-migration'

export type PersistedStorageKey = (typeof PERSISTED_STORAGE_KEYS)[number]
export type PersistedStorageSnapshot = Partial<Record<PersistedStorageKey, string>>

interface ReadableStorage {
  getItem(key: string): string | null
}

interface WritableStorage extends ReadableStorage {
  setItem(key: string, value: string): void
}

export type StorageMigrationStep = 'migrate' | 'acknowledge' | 'unavailable'

/** Keep only the fixed string-valued preference keys accepted by migration IPC. */
export function parsePersistedStorageSnapshot(value: unknown): PersistedStorageSnapshot | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const snapshot: PersistedStorageSnapshot = {}
  for (const key of PERSISTED_STORAGE_KEYS) {
    const stored = record[key]
    if (stored !== undefined && typeof stored !== 'string') return null
    if (typeof stored === 'string') snapshot[key] = stored
  }
  return snapshot
}

export function storageMigrationStep(storage: ReadableStorage): StorageMigrationStep {
  try {
    return storage.getItem(STORAGE_ORIGIN_MARKER) === '1' ? 'acknowledge' : 'migrate'
  } catch {
    return 'unavailable'
  }
}

export function storageMigrationPending(storage: ReadableStorage): boolean {
  return storageMigrationStep(storage) === 'migrate'
}

/** Copy only missing values so a preference already written at the new
 * origin always wins. The marker is written last; a quota failure therefore
 * leaves the migration retryable on the next launch. */
export function applyStorageOriginMigration(storage: WritableStorage, value: unknown): boolean {
  if (!storageMigrationPending(storage)) return false
  const snapshot = parsePersistedStorageSnapshot(value)
  if (!snapshot) return false
  try {
    for (const key of PERSISTED_STORAGE_KEYS) {
      if (storage.getItem(key) === null && snapshot[key] !== undefined) {
        storage.setItem(key, snapshot[key])
      }
    }
    storage.setItem(STORAGE_ORIGIN_MARKER, '1')
    return true
  } catch {
    return false
  }
}
