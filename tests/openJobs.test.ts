import { describe, expect, it, vi } from 'vitest'
import { OpenJobCoordinator } from '../src/main/openJobs'

describe('main base-open jobs', () => {
  it('keeps read jobs provisional until the renderer accepts their intent', () => {
    const jobs = new OpenJobCoordinator<object>()
    const owner = {}
    const older = jobs.begin(1, jobs.capture(owner))!

    // Beginning the read is still provisional: a later renderer discard
    // confirmation may decline it without suppressing another operation.
    expect(jobs.isCurrent(older)).toBe(true)
    expect(jobs.current()).toBe(0)
  })

  it('aborts an older read and drops its late completion after a newer accept', () => {
    const jobs = new OpenJobCoordinator<object>()
    const owner = {}
    const older = jobs.begin(1, jobs.capture(owner))!
    const abort = vi.fn()
    older.signal.addEventListener('abort', abort)

    expect(jobs.accept(2)).toBe(true)
    expect(abort).toHaveBeenCalledTimes(1)
    expect(older.signal.aborted).toBe(true)
    expect(jobs.isCurrent(older)).toBe(false)
    expect(jobs.begin(1, jobs.capture(owner))).toBeNull()
  })

  it('does not suppress an older read merely because a newer read started', () => {
    const jobs = new OpenJobCoordinator<object>()
    const owner = {}
    const older = jobs.begin(1, jobs.capture(owner))!
    const declined = jobs.begin(2, jobs.capture(owner))!

    expect(older.signal.aborted).toBe(false)
    expect(jobs.isCurrent(older)).toBe(true)
    jobs.finish(declined)
    expect(jobs.current()).toBe(0)
    expect(jobs.isCurrent(older)).toBe(true)

    jobs.accept(2)
    expect(older.signal.aborted).toBe(true)
  })

  it('invalidates the old document without resetting the application watermark', () => {
    const jobs = new OpenJobCoordinator<object>()
    const owner = {}
    const oldDocument = jobs.capture(owner)
    const oldRead = jobs.begin(3, oldDocument)!
    jobs.accept(3)

    jobs.invalidateOwner(owner)
    expect(oldRead.signal.aborted).toBe(true)
    expect(jobs.scopeIsCurrent(oldDocument)).toBe(false)
    expect(jobs.begin(3, oldDocument)).toBeNull()
    expect(jobs.current()).toBe(3)

    const replacement = jobs.capture(owner)
    const next = jobs.begin(4, replacement)
    expect(next).not.toBeNull()
    expect(jobs.isCurrent(next!)).toBe(true)
  })

  it('makes a delayed scope stale without rereading its destroyed owner container', () => {
    const jobs = new OpenJobCoordinator<object>()
    const owner = {}
    let destroyed = false
    let ownerReads = 0
    const container = {
      get owner(): object {
        ownerReads++
        if (destroyed) throw new Error('Object has been destroyed')
        return owner
      }
    }
    const capturedOwner = container.owner
    const scope = jobs.capture(capturedOwner)

    destroyed = true
    jobs.invalidateOwner(capturedOwner)

    expect(jobs.begin(4, scope)).toBeNull()
    expect(ownerReads).toBe(1)
    expect(() => container.owner).toThrow('Object has been destroyed')
  })

  it('keeps owners isolated while application intent ordering stays global', () => {
    const jobs = new OpenJobCoordinator<object>()
    const firstOwner = {}
    const secondOwner = {}
    const first = jobs.begin(5, jobs.capture(firstOwner))!
    jobs.invalidateOwner(secondOwner)
    expect(jobs.isCurrent(first)).toBe(true)

    const second = jobs.begin(6, jobs.capture(secondOwner))!
    jobs.accept(6)
    expect(first.signal.aborted).toBe(true)
    expect(jobs.isCurrent(second)).toBe(true)
    jobs.finish(second)
    expect(jobs.isCurrent(second)).toBe(false)
  })
})
