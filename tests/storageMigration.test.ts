import { describe, expect, it, vi } from 'vitest'
import {
  applyStorageOriginMigration,
  parsePersistedStorageSnapshot,
  PERSISTED_STORAGE_KEYS,
  STORAGE_ORIGIN_MARKER,
  storageMigrationPending,
  storageMigrationStep
} from '../src/shared/storageMigration'

function memoryStorage(initial: Record<string, string> = {}): {
  values: Map<string, string>
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
} {
  const values = new Map(Object.entries(initial))
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value)
  }
}

describe('storage origin migration', () => {
  it('accepts only the fixed string-valued preference keys', () => {
    expect(
      parsePersistedStorageSnapshot({
        [PERSISTED_STORAGE_KEYS[0]]: '{"entries":{}}',
        [PERSISTED_STORAGE_KEYS[1]]: 'old-format',
        ignored: 'value'
      })
    ).toEqual({
      [PERSISTED_STORAGE_KEYS[0]]: '{"entries":{}}',
      [PERSISTED_STORAGE_KEYS[1]]: 'old-format'
    })
    expect(parsePersistedStorageSnapshot({ [PERSISTED_STORAGE_KEYS[2]]: 4 })).toBeNull()
    expect(parsePersistedStorageSnapshot(null)).toBeNull()
  })

  it('copies only missing values, then makes later runs inert', () => {
    const storage = memoryStorage({ [PERSISTED_STORAGE_KEYS[1]]: 'current-format' })
    const snapshot = {
      [PERSISTED_STORAGE_KEYS[0]]: 'old-view',
      [PERSISTED_STORAGE_KEYS[1]]: 'old-format',
      [PERSISTED_STORAGE_KEYS[2]]: '/old/output'
    }

    expect(applyStorageOriginMigration(storage, snapshot)).toBe(true)
    expect(storage.values.get(PERSISTED_STORAGE_KEYS[0])).toBe('old-view')
    expect(storage.values.get(PERSISTED_STORAGE_KEYS[1])).toBe('current-format')
    expect(storage.values.get(PERSISTED_STORAGE_KEYS[2])).toBe('/old/output')
    expect(storage.values.get(STORAGE_ORIGIN_MARKER)).toBe('1')

    storage.values.delete(PERSISTED_STORAGE_KEYS[0])
    expect(applyStorageOriginMigration(storage, snapshot)).toBe(false)
    expect(storage.values.has(PERSISTED_STORAGE_KEYS[0])).toBe(false)
  })

  it('leaves migration retryable when writing the final marker fails', () => {
    const storage = memoryStorage()
    const setItem = vi.fn((key: string, value: string) => {
      if (key === STORAGE_ORIGIN_MARKER) throw new Error('quota')
      storage.values.set(key, value)
    })

    expect(
      applyStorageOriginMigration(
        { getItem: storage.getItem, setItem },
        { [PERSISTED_STORAGE_KEYS[0]]: 'view' }
      )
    ).toBe(false)
    expect(storageMigrationPending(storage)).toBe(true)
    expect(storage.values.get(PERSISTED_STORAGE_KEYS[0])).toBe('view')
  })

  it('treats inaccessible storage as non-migratable', () => {
    expect(
      storageMigrationPending({
        getItem: () => {
          throw new Error('unavailable')
        }
      })
    ).toBe(false)
  })

  it('acknowledges an existing local marker so main can recover a lost disk marker', () => {
    const storage = memoryStorage({ [STORAGE_ORIGIN_MARKER]: '1' })
    expect(storageMigrationStep(storage)).toBe('acknowledge')
    expect(storageMigrationPending(storage)).toBe(false)
  })
})
