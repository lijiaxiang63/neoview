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

export interface HistoryEntry<Snap = unknown> {
  /** Voxel changes; null when the operation only touched the region list. */
  patch: LabelPatch | null
  /** Whole-map replacement. Ordered undo/redo applies later patches before
   * swapping, so each retained map is back at the exact state captured here. */
  mapSwap?: { before: Uint16Array | null; after: Uint16Array | null }
  /** Whole snapshot-table replacement paired with a whole-map operation. */
  snapshots?: { before: Record<number, Snap>; after: Record<number, Snap> }
  selection?: {
    before: { active: number | null; edit: number | null }
    after: { active: number | null; edit: number | null }
  }
  /** Region-list change (commit/delete); absent for pure voxel edits. */
  regions?: { before: Region[]; after: Region[] }
  /** nextRegionId change (a commit that created a region). */
  nextId?: { before: number; after: number }
  /** Cleanliness before/after operations whose two states are both saved. */
  dirty?: { before: boolean; after: boolean }
  /** One region's saved commit snapshot changed (a re-segment overwrites
   * it); undo must put the old one back, or the next re-edit of the region
   * opens with the undone box/params. `before` undefined = none existed.
   * The snapshot type lives with the store — history stays store-agnostic. */
  snapshot?: { id: number; before: Snap | undefined; after: Snap }
}

export const HISTORY_MAX_ENTRIES = 50
/** Byte budget across every retained patch backing allocation. Exact patches
 * use 8 bytes per voxel; dense staging reuse may retain bounded spare slots. */
export const HISTORY_MAX_BYTES = 192 * 1024 * 1024

export function entryBytes(e: HistoryEntry): number {
  if (e.mapSwap) {
    const buffers = new Set<ArrayBufferLike>()
    if (e.mapSwap.after) buffers.add(e.mapSwap.after.buffer)
    if (e.mapSwap.before) buffers.add(e.mapSwap.before.buffer)
    let bytes = 0
    for (const buffer of buffers) bytes += buffer.byteLength
    return bytes
  }
  if (!e.patch) return 0
  // Dense bulk patches can be subarray views over reused staging. Budget the
  // retained backing allocations, not just the visible view lengths, or the
  // history cap can undercount every such entry by nearly one quarter.
  const buffers = new Set<ArrayBufferLike>([
    e.patch.indices.buffer,
    e.patch.before.buffer,
    e.patch.after.buffer
  ])
  let bytes = 0
  for (const buffer of buffers) bytes += buffer.byteLength
  return bytes
}

/** Append an entry, evicting the oldest while over the entry/byte caps. */
export function pushEntry<Snap>(
  stack: readonly HistoryEntry<Snap>[],
  entry: HistoryEntry<Snap>,
  maxEntries = HISTORY_MAX_ENTRIES,
  maxBytes = HISTORY_MAX_BYTES
): HistoryEntry<Snap>[] {
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

/**
 * Collector for operations that can touch millions of voxels. Unlike the
 * brush-oriented collector above, it never stores indices in boxed JS arrays
 * or a hash Set. Unique-input operations need no tracking; replacement commits
 * use a sparse typed hash that switches to a compact bitset when dense.
 */
export class BulkChangeCollector {
  private indices: Uint32Array
  private old: Uint16Array
  private seenSlots: Uint32Array | null = null
  private seenBits: Uint8Array | null = null
  private readonly domainSize: number
  private readonly deduplicate: boolean
  private length = 0

  constructor(domainSize: number, expectedChanges = 0, deduplicate = true) {
    const size = Math.max(0, Math.floor(domainSize))
    const capacity = Math.min(size, Math.max(16, Math.floor(expectedChanges)))
    this.indices = new Uint32Array(capacity)
    this.old = new Uint16Array(capacity)
    this.domainSize = size
    this.deduplicate = deduplicate
    if (deduplicate && size > 0) this.createSeenStorage(capacity)
  }

  record(index: number, oldValue: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.domainSize) return
    if (this.deduplicate && !this.markSeen(index)) return
    this.ensureCapacity(this.length + 1)
    this.indices[this.length] = index
    this.old[this.length] = oldValue
    this.length++
  }

  get size(): number {
    return this.length
  }

  /** Temporary bytes used only for first-write tracking (not patch staging).
   * Exposed so regression tests can lock down sparse-domain behavior. */
  get trackingBytes(): number {
    return this.seenBits?.byteLength ?? this.seenSlots?.byteLength ?? 0
  }

  finish(labelMap: Uint16Array): LabelPatch | null {
    let changed = 0
    for (let i = 0; i < this.length; i++) {
      if (labelMap[this.indices[i]] !== this.old[i]) changed++
    }
    if (changed === 0) return null
    const reuseStaging = changed * 4 >= this.indices.length * 3
    const indices = reuseStaging ? this.indices : new Uint32Array(changed)
    const before = reuseStaging ? this.old : new Uint16Array(changed)
    const after = new Uint16Array(changed)
    let p = 0
    for (let i = 0; i < this.length; i++) {
      const index = this.indices[i]
      const now = labelMap[index]
      if (now === this.old[i]) continue
      indices[p] = index
      before[p] = this.old[i]
      after[p] = now
      p++
    }
    return {
      indices: reuseStaging ? indices.subarray(0, changed) : indices,
      before: reuseStaging ? before.subarray(0, changed) : before,
      after
    }
  }

  private ensureCapacity(wanted: number): void {
    if (wanted <= this.indices.length) return
    const capacity = Math.min(this.domainSize, Math.max(wanted, this.indices.length * 2, 16))
    const indices = new Uint32Array(capacity)
    indices.set(this.indices)
    this.indices = indices
    const old = new Uint16Array(capacity)
    old.set(this.old)
    this.old = old
  }

  private createSeenStorage(expectedChanges: number): void {
    const bitBytes = Math.ceil(this.domainSize / 8)
    const desiredSlots = Math.max(16, Math.ceil(Math.max(1, expectedChanges) / 0.65))
    if (desiredSlots * Uint32Array.BYTES_PER_ELEMENT >= bitBytes) {
      this.seenBits = new Uint8Array(bitBytes)
      return
    }
    let capacity = 16
    while (capacity < desiredSlots) capacity *= 2
    this.seenSlots = new Uint32Array(capacity)
  }

  private markSeen(index: number): boolean {
    if (this.seenBits) {
      const byte = index >>> 3
      const mask = 1 << (index & 7)
      if ((this.seenBits[byte] & mask) !== 0) return false
      this.seenBits[byte] |= mask
      return true
    }

    let slots = this.seenSlots as Uint32Array
    if ((this.length + 1) * 10 >= slots.length * 7) {
      const nextBytes = slots.length * 2 * Uint32Array.BYTES_PER_ELEMENT
      if (nextBytes >= Math.ceil(this.domainSize / 8)) {
        this.switchToBits()
        return this.markSeen(index)
      }
      this.rehash(slots.length * 2)
      slots = this.seenSlots as Uint32Array
    }

    const mask = slots.length - 1
    let slot = Math.imul(index, 0x9e3779b1) & mask
    while (slots[slot] !== 0) {
      if (this.indices[slots[slot] - 1] === index) return false
      slot = (slot + 1) & mask
    }
    // Store staging position + 1 so slot value 0 remains the empty sentinel.
    slots[slot] = this.length + 1
    return true
  }

  private rehash(capacity: number): void {
    const slots = new Uint32Array(capacity)
    const mask = capacity - 1
    for (let entry = 0; entry < this.length; entry++) {
      const index = this.indices[entry]
      let slot = Math.imul(index, 0x9e3779b1) & mask
      while (slots[slot] !== 0) slot = (slot + 1) & mask
      slots[slot] = entry + 1
    }
    this.seenSlots = slots
  }

  private switchToBits(): void {
    const bits = new Uint8Array(Math.ceil(this.domainSize / 8))
    for (let entry = 0; entry < this.length; entry++) {
      const index = this.indices[entry]
      bits[index >>> 3] |= 1 << (index & 7)
    }
    this.seenSlots = null
    this.seenBits = bits
  }
}
