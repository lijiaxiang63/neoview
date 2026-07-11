import { describe, expect, it, vi } from 'vitest'
import {
  createUpdateIpcPort,
  registerUpdateIpc,
  type UpdateIpcDependencies,
  type UpdateIpcPort
} from '../src/main/updateIpc'
import { createRendererMainFrameGate } from '../src/main/rendererProtocol'
import type { UpdateSnapshot } from '../src/shared/updates'

type Handler = (...args: unknown[]) => unknown

function harness(): {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  emit(channel: string, ...args: unknown[]): void
  controller: UpdateIpcDependencies['controller'] & {
    download: ReturnType<typeof vi.fn>
    cancelDownload: ReturnType<typeof vi.fn>
    skip: ReturnType<typeof vi.fn>
    dismiss: ReturnType<typeof vi.fn>
    installFailed: ReturnType<typeof vi.fn>
  }
  install: ReturnType<typeof vi.fn>
  publish: ReturnType<typeof vi.fn>
  snapshot: UpdateSnapshot
  dispose(): void
  registered(): { handles: number; listeners: number }
} {
  const handles = new Map<string, Handler>()
  const listeners = new Map<string, Handler>()
  const port: UpdateIpcPort = {
    handle(channel, handler) {
      if (handles.has(channel)) throw new Error(`duplicate handler: ${channel}`)
      handles.set(channel, handler)
      return () => handles.delete(channel)
    },
    listen(channel, handler) {
      if (listeners.has(channel)) throw new Error(`duplicate listener: ${channel}`)
      listeners.set(channel, handler)
      return () => listeners.delete(channel)
    }
  }
  const snapshot: UpdateSnapshot = {
    revision: 9,
    commandId: 7,
    state: {
      phase: 'ready',
      info: {
        version: '2.0.0',
        notesUrl: 'https://example.test/release',
        assetName: 'installer.bin',
        assetSize: 100
      },
      error: null
    }
  }
  const controller = {
    snapshot: vi.fn(() => snapshot),
    download: vi.fn(async (commandId: number) => `/tmp/${commandId}`),
    cancelDownload: vi.fn(),
    skip: vi.fn(),
    dismiss: vi.fn(),
    installFailed: vi.fn()
  }
  const install = vi.fn(async () => ({ quits: true }))
  const publish = vi.fn()
  const dispose = registerUpdateIpc({ port, controller, install, publish })

  return {
    invoke: async (channel, ...args) => {
      const handler = handles.get(channel)
      if (!handler) throw new Error(`missing handler: ${channel}`)
      return handler(...args)
    },
    emit: (channel, ...args) => {
      const listener = listeners.get(channel)
      if (!listener) throw new Error(`missing listener: ${channel}`)
      listener(...args)
    },
    controller,
    install,
    publish,
    snapshot,
    dispose,
    registered: () => ({ handles: handles.size, listeners: listeners.size })
  }
}

describe('update IPC registration', () => {
  it('routes every current command with the production channel argument order', async () => {
    const h = harness()

    expect(await h.invoke('update-state')).toBe(h.snapshot)
    await expect(h.invoke('update-download', 7)).resolves.toBe('/tmp/7')
    h.emit('update-download-cancel', 7)
    h.emit('update-skip', '2.0.0', 7)
    h.emit('update-dismiss', 7)
    await expect(h.invoke('update-install', 7)).resolves.toEqual({ quits: true })

    expect(h.controller.download).toHaveBeenCalledWith(7)
    expect(h.controller.cancelDownload).toHaveBeenCalledWith(7)
    expect(h.controller.skip).toHaveBeenCalledWith('2.0.0', 7)
    expect(h.controller.dismiss).toHaveBeenCalledWith(7)
    expect(h.install).toHaveBeenCalledWith(7)
    expect(h.publish).not.toHaveBeenCalled()

    expect(h.registered()).toEqual({ handles: 3, listeners: 3 })
    h.dispose()
    h.dispose()
    expect(h.registered()).toEqual({ handles: 0, listeners: 0 })
  })

  it('rejects malformed payloads and stale install commands by replaying state', async () => {
    const h = harness()
    const malformed = [undefined, null, '7', -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]
    const malformedVersions = [{}, 7, true, null]

    for (const commandId of malformed) {
      await expect(h.invoke('update-download', commandId)).resolves.toBeNull()
      h.emit('update-download-cancel', commandId)
      h.emit('update-skip', '2.0.0', commandId)
      h.emit('update-dismiss', commandId)
      await expect(h.invoke('update-install', commandId)).resolves.toEqual({ quits: false })
    }
    for (const version of malformedVersions) h.emit('update-skip', version, 7)
    h.emit('update-skip', '', 7)
    await expect(h.invoke('update-install', 6)).resolves.toEqual({ quits: false })

    expect(h.controller.download).not.toHaveBeenCalled()
    expect(h.controller.cancelDownload).not.toHaveBeenCalled()
    expect(h.controller.skip).not.toHaveBeenCalled()
    expect(h.controller.dismiss).not.toHaveBeenCalled()
    expect(h.install).not.toHaveBeenCalled()
    expect(h.publish).toHaveBeenCalledTimes(malformed.length * 5 + malformedVersions.length + 2)
    expect(h.publish).toHaveBeenCalledWith(h.snapshot)
  })

  it('reports an accepted install failure back to authoritative state ownership', async () => {
    const h = harness()
    h.install.mockRejectedValueOnce(new Error('Preparation failed.'))

    await expect(h.invoke('update-install', 7)).rejects.toThrow('Preparation failed.')

    expect(h.controller.installFailed).toHaveBeenCalledWith(7, 'Preparation failed.')
  })

  it('rolls back earlier channels when registration fails partway through', () => {
    const releases: Array<ReturnType<typeof vi.fn>> = []
    let registrations = 0
    const port: UpdateIpcPort = {
      handle() {
        if (++registrations === 3) throw new Error('registration failed')
        const release = vi.fn()
        releases.push(release)
        return release
      },
      listen() {
        throw new Error('unexpected listener')
      }
    }
    const snapshot = { revision: 0, commandId: 0, state: { phase: 'idle' } } as const

    expect(() =>
      registerUpdateIpc({
        port,
        controller: {
          snapshot: () => snapshot,
          download: async () => null,
          cancelDownload: () => {},
          skip: () => {},
          dismiss: () => {},
          installFailed: () => {}
        },
        publish: () => {},
        install: async () => ({ quits: false })
      })
    ).toThrow('registration failed')
    expect(releases).toHaveLength(2)
    expect(releases[0]).toHaveBeenCalledTimes(1)
    expect(releases[1]).toHaveBeenCalledTimes(1)
  })
})

describe('update IPC renderer boundary', () => {
  it('rejects remote current-main-frame invokes and ignores its events', () => {
    const handles = new Map<string, (...args: unknown[]) => unknown>()
    const listeners = new Map<string, (...args: unknown[]) => void>()
    const ipc = {
      handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
        handles.set(channel, handler),
      removeHandler: (channel: string) => handles.delete(channel),
      on: (channel: string, listener: (...args: unknown[]) => void) =>
        listeners.set(channel, listener),
      removeListener: (channel: string, listener: (...args: unknown[]) => void) => {
        if (listeners.get(channel) === listener) listeners.delete(channel)
      }
    } as unknown as Parameters<typeof createUpdateIpcPort>[0]
    const port = createUpdateIpcPort(ipc, createRendererMainFrameGate(null))
    const invoked = vi.fn((value: unknown) => value)
    const received = vi.fn()
    const releaseHandle = port.handle('invoke', invoked)
    const releaseListener = port.listen('event', received)
    const event = (url: string): object => {
      const frame = { url }
      return { sender: { mainFrame: frame }, senderFrame: frame }
    }

    expect(() => handles.get('invoke')!(event('https://remote.test/'), 1)).toThrow(
      'Update operation is unavailable.'
    )
    listeners.get('event')!(event('https://remote.test/'), 2)
    expect(invoked).not.toHaveBeenCalled()
    expect(received).not.toHaveBeenCalled()

    expect(handles.get('invoke')!(event('app://renderer/index.html'), 3)).toBe(3)
    listeners.get('event')!(event('app://renderer/index.html'), 4)
    expect(invoked).toHaveBeenCalledWith(3)
    expect(received).toHaveBeenCalledWith(4)

    releaseListener()
    releaseHandle()
    expect(handles.size).toBe(0)
    expect(listeners.size).toBe(0)
  })
})
