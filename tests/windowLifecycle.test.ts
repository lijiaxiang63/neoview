import { describe, expect, it, vi } from 'vitest'
import { needsCloseConfirmation, sendIfAlive } from '../src/main/windowLifecycle'

interface WindowHarness {
  window: {
    isDestroyed(): boolean
    webContents: { isDestroyed(): boolean; send: ReturnType<typeof vi.fn> }
  }
  send: ReturnType<typeof vi.fn>
}

function windowHarness(options: {
  windowGone?: boolean
  contentsGone?: boolean
  sendFails?: boolean
}): WindowHarness {
  const send = vi.fn(() => {
    if (options.sendFails) throw new Error('destroyed during send')
  })
  return {
    window: {
      isDestroyed: () => options.windowGone === true,
      webContents: {
        isDestroyed: () => options.contentsGone === true,
        send
      }
    },
    send
  }
}

describe('window message delivery', () => {
  it.each([{ windowGone: true }, { contentsGone: true }, { sendFails: true }])(
    'contains delivery after an awaited window lifetime race: %o',
    (options) => {
      const h = windowHarness(options)
      expect(sendIfAlive(h.window, 'file-opened', { bytes: new ArrayBuffer(1) })).toBe(false)
    }
  )

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
