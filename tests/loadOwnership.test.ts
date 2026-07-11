import { describe, expect, it } from 'vitest'
import { LoadFeedbackGroup, PrefetchSlot } from '../src/renderer/src/files/loadOwnership'

describe('load ownership helpers', () => {
  it('settles feedback only after the last active member and keeps the latest failure', () => {
    const group = new LoadFeedbackGroup()
    const first = group.begin()
    const second = group.begin()
    expect(group.finish(first, true, 'first')).toBeNull()
    expect(group.finish(second, true, 'second')).toEqual({ failed: true, failure: 'second' })
    expect(group.finish(second, false)).toBeNull()
  })

  it('keeps cached bytes across active cancellation but releases them at session end', () => {
    const slot = new PrefetchSlot()
    const first = slot.begin()
    const bytes = new ArrayBuffer(4)
    expect(slot.store(first, '/a', bytes)).toBe(true)
    slot.finish(first)
    expect(slot.take('/a')).toBe(bytes)

    const second = slot.begin()
    slot.cancelActive()
    expect(second.abort.signal.aborted).toBe(true)
    expect(slot.store(second, '/b', new ArrayBuffer(1))).toBe(false)

    const third = slot.begin()
    expect(slot.store(third, '/c', bytes)).toBe(true)
    slot.release()
    expect(slot.take('/c')).toBeNull()
  })
})
