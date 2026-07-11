import { describe, expect, it, vi } from 'vitest'
import {
  CloseResponderLeaseState,
  needsCloseConfirmation,
  sendIfAlive,
  WindowCloseCoordinator
} from '../src/main/windowLifecycle'

interface WindowHarness {
  window: {
    isDestroyed(): boolean
    webContents: { isDestroyed(): boolean; send: ReturnType<typeof vi.fn> }
  }
  send: ReturnType<typeof vi.fn>
}

function windowHarness(options: {
  windowGone?: boolean
  windowCheckFails?: boolean
  getterFails?: boolean
  contentsGone?: boolean
  contentsCheckFails?: boolean
  sendFails?: boolean
}): WindowHarness {
  const send = vi.fn(() => {
    if (options.sendFails) throw new Error('destroyed during send')
  })
  const webContents = {
    isDestroyed: (): boolean => {
      if (options.contentsCheckFails) throw new Error('contents destroyed during check')
      return options.contentsGone === true
    },
    send
  }
  return {
    window: {
      isDestroyed: () => {
        if (options.windowCheckFails) throw new Error('window destroyed during check')
        return options.windowGone === true
      },
      get webContents() {
        if (options.getterFails) throw new Error('Object has been destroyed')
        return webContents
      }
    },
    send
  }
}

describe('window message delivery', () => {
  it.each([
    { windowGone: true },
    { windowCheckFails: true },
    { getterFails: true },
    { contentsGone: true },
    { contentsCheckFails: true },
    { sendFails: true }
  ])('contains delivery after an awaited window lifetime race: %o', (options) => {
    const h = windowHarness(options)
    expect(sendIfAlive(h.window, 'file-opened', { bytes: new ArrayBuffer(1) })).toBe(false)
  })

  it('delivers exactly once while both owners are alive', () => {
    const h = windowHarness({})
    expect(sendIfAlive(h.window, 'file-opened', 1)).toBe(true)
    expect(h.send).toHaveBeenCalledWith('file-opened', 1)
  })
})

describe('close confirmation availability', () => {
  it('bypasses the renderer gate after process loss or destruction', () => {
    expect(needsCloseConfirmation(false, false, false)).toBe(false)
    expect(needsCloseConfirmation(false, true, true)).toBe(false)
  })

  it('requires confirmation only from a live renderer', () => {
    expect(needsCloseConfirmation(false, true, false)).toBe(true)
    expect(needsCloseConfirmation(true, true, false)).toBe(false)
  })
})

describe('close responder leases', () => {
  it('restores protection only after a replacement renderer activates its lease', () => {
    const leases = new CloseResponderLeaseState()
    const first = leases.claim()
    expect(leases.isReady()).toBe(false)
    expect(leases.activate(first)).toBe(true)
    expect(leases.isReady()).toBe(true)
    expect(leases.activeLeaseId()).toBe(first)

    leases.rendererLost()
    expect(leases.isReady()).toBe(false)
    expect(leases.activeLeaseId()).toBeNull()
    const replacement = leases.claim()
    expect(leases.isReady()).toBe(false)
    expect(leases.activate(replacement)).toBe(true)
    expect(leases.isReady()).toBe(true)
  })

  it('keeps an active owner until replacement activation and ignores its late release', () => {
    const leases = new CloseResponderLeaseState()
    const first = leases.claim()
    leases.activate(first)
    const replacement = leases.claim()
    expect(leases.isReady()).toBe(true)
    expect(leases.activate(first)).toBe(false)
    expect(leases.activate(replacement)).toBe(true)
    expect(leases.release(first)).toBe(false)
    expect(leases.owns(replacement)).toBe(true)
    expect(leases.activeLeaseId()).toBe(replacement)
    expect(leases.isReady()).toBe(true)
  })

  it('makes replacement activation a one-shot transition for pending-request replay', () => {
    const leases = new CloseResponderLeaseState()
    const first = leases.claim()
    expect(leases.activate(first)).toBe(true)
    expect(leases.activate(first)).toBe(false)
    const replacement = leases.claim()
    expect(leases.activate(replacement)).toBe(true)
    expect(leases.activate(replacement)).toBe(false)
  })

  it('revokes a navigation lease and reports release only for the active owner', () => {
    const leases = new CloseResponderLeaseState()
    const first = leases.claim()
    leases.activate(first)
    leases.navigationCommitted()
    expect(leases.isReady()).toBe(false)
    expect(leases.release(first)).toBe(false)
    const replacement = leases.claim()
    leases.activate(replacement)
    expect(leases.release(replacement)).toBe(true)
    expect(leases.isReady()).toBe(false)
  })

  it('keeps a live close request protected until a replacement document commits', () => {
    const leases = new CloseResponderLeaseState()
    const close = new WindowCloseCoordinator()
    const lease = leases.claim()
    leases.activate(lease)
    close.request(false)

    // A provisional, redirected or failed load causes no ownership transition.
    expect(leases.isReady()).toBe(true)
    expect(close.isAwaiting()).toBe(true)

    leases.navigationCommitted()
    expect(leases.isReady()).toBe(false)
    expect(close.rendererLost()).toBe('close-window')
  })
})

describe('window close coordinator', () => {
  it('coalesces repeated closes and upgrades an outstanding request to app quit', () => {
    const close = new WindowCloseCoordinator()
    expect(close.request(false)).toEqual({ kind: 'prompt', requestId: 1 })
    expect(close.request(false)).toEqual({ kind: 'waiting', requestId: 1 })
    expect(close.request(true)).toEqual({ kind: 'waiting', requestId: 1 })
    expect(close.confirm(1)).toBe('quit-app')
    expect(close.request(false)).toEqual({ kind: 'allow' })
  })

  it('requires the active request id and ignores late replies', () => {
    const close = new WindowCloseCoordinator()
    expect(close.request(false)).toEqual({ kind: 'prompt', requestId: 1 })
    expect(close.cancel(2)).toBe(false)
    expect(close.confirm(2)).toBeNull()
    expect(close.cancel(1)).toBe(true)
    expect(close.confirm(1)).toBeNull()
    expect(close.request(false)).toEqual({ kind: 'prompt', requestId: 2 })
  })

  it('bypasses a missing renderer while preserving the pending resolution', () => {
    const close = new WindowCloseCoordinator()
    close.request(true)
    expect(close.rendererLost()).toBe('quit-app')
    expect(close.rendererLost()).toBeNull()
    expect(close.isAllowed()).toBe(true)
  })

  it('does not permanently authorize close when renderer loss had no pending request', () => {
    const close = new WindowCloseCoordinator()
    expect(close.rendererLost()).toBeNull()
    expect(close.isAllowed()).toBe(false)
    expect(close.request(false)).toEqual({ kind: 'prompt', requestId: 1 })
  })

  it('keeps a live responder request pending until an explicit reply or loss', () => {
    const close = new WindowCloseCoordinator()
    close.request(false)
    expect(close.isAwaiting()).toBe(true)
    expect(close.isPending(1)).toBe(true)
    expect(close.isPending(2)).toBe(false)
    expect(close.request(false)).toEqual({ kind: 'waiting', requestId: 1 })
    expect(close.isAwaiting()).toBe(true)
    expect(close.confirm(1)).toBe('close-window')
    expect(close.isAllowed()).toBe(true)
  })

  it('exposes the same pending id to a replacement responder until it replies', () => {
    const leases = new CloseResponderLeaseState()
    const close = new WindowCloseCoordinator()
    const first = leases.claim()
    leases.activate(first)
    expect(close.request(false)).toEqual({ kind: 'prompt', requestId: 1 })

    const replacement = leases.claim()
    expect(leases.activate(replacement)).toBe(true)
    expect(leases.release(first)).toBe(false)
    expect(close.pendingRequestId()).toBe(1)
    expect(close.confirm(close.pendingRequestId())).toBe('close-window')
    expect(close.pendingRequestId()).toBeNull()
  })
})
