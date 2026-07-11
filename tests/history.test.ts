import { describe, expect, it } from 'vitest'
import {
  BulkChangeCollector,
  entryBytes,
  pushEntry
} from '../src/renderer/src/segmentation/history'

describe('bulk history collector', () => {
  it('deduplicates first writes and drops voxels whose final value is unchanged', () => {
    const labels = new Uint16Array([1, 1, 2, 0])
    const changes = new BulkChangeCollector(labels.length, 1)
    changes.record(0, labels[0])
    labels[0] = 0
    changes.record(0, 0)
    labels[0] = 1
    changes.record(2, labels[2])
    labels[2] = 3
    changes.record(3, labels[3])
    labels[3] = 3

    const patch = changes.finish(labels)
    expect(patch && Array.from(patch.indices)).toEqual([2, 3])
    expect(patch && Array.from(patch.before)).toEqual([2, 0])
    expect(patch && Array.from(patch.after)).toEqual([3, 3])
  })

  it('grows typed staging without losing entries', () => {
    const labels = new Uint16Array(100)
    const changes = new BulkChangeCollector(labels.length, 1)
    for (let index = 0; index < labels.length; index++) {
      changes.record(index, 0)
      labels[index] = 7
    }
    const patch = changes.finish(labels)
    expect(patch?.indices).toHaveLength(100)
    expect(patch?.after.every((value) => value === 7)).toBe(true)
  })

  it('keeps first-write tracking proportional for a huge sparse domain', () => {
    const changes = new BulkChangeCollector(268_435_456, 4)
    expect(changes.trackingBytes).toBeLessThan(1024)
    changes.record(0, 0)
    changes.record(268_435_455, 0)
    changes.record(0, 0)
    expect(changes.size).toBe(2)
  })

  it('uses no deduplication storage when the caller guarantees unique indices', () => {
    const changes = new BulkChangeCollector(268_435_456, 4, false)
    expect(changes.trackingBytes).toBe(0)
  })

  it('compacts dense results in staging instead of allocating duplicate index arrays', () => {
    const labels = new Uint16Array(100)
    const changes = new BulkChangeCollector(labels.length, labels.length, false)
    for (let index = 0; index < labels.length; index++) {
      changes.record(index, 0)
      labels[index] = index < 80 ? 4 : 0
    }

    const patch = changes.finish(labels)!
    expect(patch.indices).toHaveLength(80)
    expect(patch.indices.buffer.byteLength).toBe(100 * Uint32Array.BYTES_PER_ELEMENT)
    expect(patch.before.buffer.byteLength).toBe(100 * Uint16Array.BYTES_PER_ELEMENT)
    expect(patch.after.buffer.byteLength).toBe(80 * Uint16Array.BYTES_PER_ELEMENT)
    expect(entryBytes({ patch })).toBe(
      100 * Uint32Array.BYTES_PER_ELEMENT +
        100 * Uint16Array.BYTES_PER_ELEMENT +
        80 * Uint16Array.BYTES_PER_ELEMENT
    )
  })

  it('copies sparse results so a small patch does not retain oversized staging', () => {
    const labels = new Uint16Array(100)
    const changes = new BulkChangeCollector(labels.length, labels.length)
    for (let index = 0; index < labels.length; index++) changes.record(index, 0)
    labels[99] = 8

    const patch = changes.finish(labels)!
    expect(patch.indices.buffer.byteLength).toBe(Uint32Array.BYTES_PER_ELEMENT)
    expect(patch.before.buffer.byteLength).toBe(Uint16Array.BYTES_PER_ELEMENT)
  })

  it('evicts dense views using retained backing bytes rather than visible lengths', () => {
    const dense = {
      indices: new Uint32Array(100).subarray(0, 75),
      before: new Uint16Array(100).subarray(0, 75),
      after: new Uint16Array(75)
    }
    const retained = entryBytes({ patch: dense })
    const visible = dense.indices.byteLength + dense.before.byteLength + dense.after.byteLength
    expect(retained).toBeGreaterThan(visible)

    const stack = pushEntry([{ patch: dense }], { patch: dense }, 50, retained + visible)
    expect(stack).toHaveLength(1)
  })

  it('budgets unique backing buffers retained by a whole-map swap', () => {
    const before = new Uint16Array(12)
    const after = new Uint16Array(12)
    expect(entryBytes({ patch: null, mapSwap: { before, after } })).toBe(
      before.byteLength + after.byteLength
    )
    expect(entryBytes({ patch: null, mapSwap: { before: after, after } })).toBe(after.byteLength)
  })
})
