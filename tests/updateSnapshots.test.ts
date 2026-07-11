import { describe, expect, it } from 'vitest'
import {
  INITIAL_UPDATE_SNAPSHOT,
  newestUpdateSnapshot,
  ownedUpdateFallback,
  UpdateCommandLatch,
  UpdateSnapshotReceiver,
  updateResultAutoDismisses
} from '../src/renderer/src/runtime/updateSnapshots'
import type { UpdateSnapshot } from '../src/shared/updates'

const available = (revision: number): UpdateSnapshot => ({
  revision,
  commandId: revision,
  state: {
    phase: 'available',
    info: {
      version: '2.0.0',
      notesUrl: 'https://example.test/release',
      assetName: 'installer.bin',
      assetSize: 100
    },
    error: null
  }
})

describe('update snapshot ordering', () => {
  it('keeps a live event when an older initial query resolves afterward', () => {
    const event = available(2)
    const query = {
      revision: 1,
      commandId: 1,
      state: { phase: 'checking' }
    } satisfies UpdateSnapshot
    const afterEvent = newestUpdateSnapshot(INITIAL_UPDATE_SNAPSHOT, event)
    expect(newestUpdateSnapshot(afterEvent, query)).toBe(event)
  })

  it('accepts a newer live event after the initial query', () => {
    const query = {
      revision: 1,
      commandId: 1,
      state: { phase: 'checking' }
    } satisfies UpdateSnapshot
    const event = available(2)
    const afterQuery = newestUpdateSnapshot(INITIAL_UPDATE_SNAPSHOT, query)
    expect(newestUpdateSnapshot(afterQuery, event)).toBe(event)
  })

  it('lets an authoritative equal-revision snapshot replace a local fallback', () => {
    const local = {
      revision: 2,
      commandId: 2,
      state: { phase: 'error', message: 'Transport failed.' }
    } satisfies UpdateSnapshot
    const authoritative = available(2)
    expect(newestUpdateSnapshot(local, authoritative)).toBe(authoritative)
  })

  it('ignores a query that resolves after the receiver is disposed', () => {
    const receiver = new UpdateSnapshotReceiver()
    receiver.dispose()
    expect(receiver.accept(available(3))).toBeNull()
  })

  it('latches one renderer command until state advances or that command settles', () => {
    const latch = new UpdateCommandLatch()
    const first = latch.begin()
    expect(first).not.toBeNull()
    expect(latch.begin()).toBeNull()
    expect(latch.isPending()).toBe(true)

    expect(latch.reset()).toBe(true)
    const second = latch.begin()
    expect(second).not.toBeNull()
    expect(latch.release(first!)).toBe(false)
    expect(latch.isPending()).toBe(true)
    expect(latch.release(second!)).toBe(true)
    expect(latch.isPending()).toBe(false)
  })

  it('does not let an old rejected command overwrite a newer application snapshot', () => {
    const latch = new UpdateCommandLatch()
    const firstToken = latch.begin()!
    const first = available(2)
    const owner = {
      token: firstToken,
      revision: first.revision,
      commandId: first.commandId
    }
    const fallback = { phase: 'error', message: 'Transport failed.' } as const

    expect(ownedUpdateFallback(first, owner, latch, fallback)?.state).toEqual(fallback)
    const newer = available(3)
    expect(ownedUpdateFallback(newer, owner, latch, fallback)).toBeNull()

    latch.reset()
    const newToken = latch.begin()!
    expect(ownedUpdateFallback(first, owner, latch, fallback)).toBeNull()
    expect(
      ownedUpdateFallback(
        newer,
        { token: newToken, revision: newer.revision, commandId: newer.commandId },
        latch,
        fallback
      )?.state
    ).toEqual(fallback)
  })

  it('keeps a retryable install fallback out of the automatic dismiss path', () => {
    const current = available(4)
    if (current.state.phase !== 'available') throw new Error('unexpected state')
    const latch = new UpdateCommandLatch()
    const token = latch.begin()!
    const state = {
      phase: 'ready',
      info: current.state.info,
      error: 'Preparation failed.'
    } as const
    const fallback = ownedUpdateFallback(
      current,
      { token, revision: current.revision, commandId: current.commandId },
      latch,
      state
    )

    expect(fallback?.state).toEqual(state)
    expect(updateResultAutoDismisses(state)).toBe(false)
    expect(updateResultAutoDismisses({ phase: 'error', message: 'Check failed.' })).toBe(true)
    expect(updateResultAutoDismisses({ phase: 'saved', info: state.info })).toBe(true)
  })
})
