import { parseAppSettings, patchAppSettings, type AppSettings } from '../shared/settings'

export interface AppSettingsStoreDependencies {
  /** Raw persisted value (already JSON-parsed) or null when unreadable. */
  load(): unknown
  /** Persist one snapshot. Calls are serialized by the store. */
  save(settings: AppSettings): Promise<void>
}

export interface AppSettingsStore {
  snapshot(): AppSettings
  /** Validate and apply an untrusted partial update. Persists only when the
   * result actually changed and returns the authoritative snapshot. */
  patch(patch: unknown): AppSettings
  /** Resolves after every write accepted so far has settled. */
  settled(): Promise<void>
}

/** Main-process owner of the persisted application settings. Reads once at
 * construction; writes are serialized through one tail so a slow disk can
 * never reorder snapshots, and a failed write never breaks later ones. */
export function createAppSettingsStore(deps: AppSettingsStoreDependencies): AppSettingsStore {
  let current = parseAppSettings(deps.load())
  let tail: Promise<void> = Promise.resolve()

  const persist = (snapshot: AppSettings): void => {
    tail = tail.then(
      () => deps.save(snapshot),
      () => deps.save(snapshot)
    )
  }

  return {
    snapshot: () => current,
    patch(patch) {
      const next = patchAppSettings(current, patch)
      // Structural comparison (patchAppSettings builds both shapes with the
      // same key order), so a future settings field cannot silently skip
      // persistence by being missing from a hand-written field list.
      if (JSON.stringify(next) !== JSON.stringify(current)) {
        current = next
        persist(next)
      }
      return current
    },
    settled: () =>
      tail.then(
        () => undefined,
        () => undefined
      )
  }
}
