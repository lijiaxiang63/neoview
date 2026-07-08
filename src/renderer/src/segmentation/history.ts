import type { Region } from './regions'

/**
 * Undo/redo for label-map edits, as reverse/forward value patches: every
 * undoable operation (paint stroke, commit, delete) records the voxels it
 * changed with their values before and after. Applying `before` in any order
 * undoes the operation; `after` redoes it — no full-map snapshots.
 */

export interface LabelPatch {
  indices: Uint32Array
  before: Uint16Array
  after: Uint16Array
}

export interface HistoryEntry {
  /** Voxel changes; null when the operation only touched the region list. */
  patch: LabelPatch | null
  /** Region-list change (commit/delete); absent for pure voxel edits. */
  regions?: { before: Region[]; after: Region[] }
  /** nextRegionId change (a commit that created a region). */
  nextId?: { before: number; after: number }
}

export const HISTORY_MAX_ENTRIES = 50
/** Byte budget across all retained patches (8 bytes per recorded voxel). */
export const HISTORY_MAX_BYTES = 192 * 1024 * 1024

export function entryBytes(e: HistoryEntry): number {
  return e.patch
    ? e.patch.indices.byteLength + e.patch.before.byteLength + e.patch.after.byteLength
    : 0
}

/** Append an entry, evicting the oldest while over the entry/byte caps. */
export function pushEntry(
  stack: readonly HistoryEntry[],
  entry: HistoryEntry,
  maxEntries = HISTORY_MAX_ENTRIES,
  maxBytes = HISTORY_MAX_BYTES
): HistoryEntry[] {
  const next = [...stack, entry]
  let bytes = 0
  for (const e of next) bytes += entryBytes(e)
  while (next.length > 1 && (next.length > maxEntries || bytes > maxBytes)) {
    bytes -= entryBytes(next[0])
    next.shift()
  }
  return next
}

export function applyPatchValues(
  labelMap: Uint16Array,
  indices: Uint32Array,
  values: Uint16Array
): void {
  for (let i = 0; i < indices.length; i++) labelMap[indices[i]] = values[i]
}

/** Patch for an erase that cleared `id` at `indices` (delete undo). */
export function patchFromErase(indices: Uint32Array, id: number): LabelPatch | null {
  if (indices.length === 0) return null
  const before = new Uint16Array(indices.length).fill(id)
  const after = new Uint16Array(indices.length)
  return { indices, before, after }
}

/**
 * Records the first-write old value of every voxel one gesture touches
 * (a stroke stamps overlapping disks; only the first write's old value
 * matters). `finish` reads the final values back from the live map and drops
 * voxels that ended where they started.
 */
export class ChangeCollector {
  private idx: number[] = []
  private old: number[] = []
  private seen = new Set<number>()

  record(index: number, oldValue: number): void {
    if (this.seen.has(index)) return
    this.seen.add(index)
    this.idx.push(index)
    this.old.push(oldValue)
  }

  get size(): number {
    return this.idx.length
  }

  finish(labelMap: Uint16Array): LabelPatch | null {
    let changed = 0
    for (let i = 0; i < this.idx.length; i++) {
      if (labelMap[this.idx[i]] !== this.old[i]) changed++
    }
    if (changed === 0) return null
    const indices = new Uint32Array(changed)
    const before = new Uint16Array(changed)
    const after = new Uint16Array(changed)
    let p = 0
    for (let i = 0; i < this.idx.length; i++) {
      const index = this.idx[i]
      const now = labelMap[index]
      if (now === this.old[i]) continue
      indices[p] = index
      before[p] = this.old[i]
      after[p] = now
      p++
    }
    return { indices, before, after }
  }
}
