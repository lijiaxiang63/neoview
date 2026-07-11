import { describe, expect, it, vi } from 'vitest'
import { registerSettingsIpc, type SettingsIpcDependencies } from '../src/main/settingsIpc'
import { createAppSettingsStore } from '../src/main/appSettings'
import { createRendererMainFrameGate, RENDERER_ORIGIN } from '../src/main/rendererProtocol'
import { defaultAppSettings, SETTINGS_CHANNELS } from '../src/shared/settings'

type Handler = (...args: unknown[]) => unknown

function trustedEvent(): { sender: { mainFrame: { url: string } }; senderFrame: { url: string } } {
  const frame = { url: `${RENDERER_ORIGIN}/settings.html` }
  return { sender: { mainFrame: frame }, senderFrame: frame }
}

function foreignEvent(): { sender: { mainFrame: { url: string } }; senderFrame: { url: string } } {
  const frame = { url: 'https://example.test/page' }
  return { sender: { mainFrame: frame }, senderFrame: frame }
}

function harness(overrides: Partial<SettingsIpcDependencies> = {}): {
  invoke(channel: string, ...args: unknown[]): unknown
  emit(channel: string, ...args: unknown[]): void
  broadcast: ReturnType<typeof vi.fn>
  save: ReturnType<typeof vi.fn>
  dispose(): void
  registered(): { handles: number; listeners: number }
} {
  const handles = new Map<string, Handler>()
  const listeners = new Map<string, Handler>()
  const ipc: SettingsIpcDependencies['ipc'] = {
    handle: (channel, handler) => {
      if (handles.has(channel)) throw new Error(`duplicate handler: ${channel}`)
      handles.set(channel, handler as Handler)
    },
    removeHandler: (channel) => void handles.delete(channel),
    on: ((channel: string, listener: Handler) => {
      if (listeners.has(channel)) throw new Error(`duplicate listener: ${channel}`)
      listeners.set(channel, listener)
    }) as SettingsIpcDependencies['ipc']['on'],
    removeListener: ((channel: string) => {
      listeners.delete(channel)
    }) as SettingsIpcDependencies['ipc']['removeListener']
  }
  const save = vi.fn(async () => {})
  const store = createAppSettingsStore({ load: () => null, save })
  const broadcast = vi.fn()
  const dispose = registerSettingsIpc({
    ipc,
    store,
    isTrustedMainFrame: createRendererMainFrameGate(null),
    broadcast,
    ...overrides
  })
  return {
    invoke: (channel, ...args) => {
      const handler = handles.get(channel)
      if (!handler) throw new Error(`missing handler: ${channel}`)
      return handler(...args)
    },
    emit: (channel, ...args) => {
      const listener = listeners.get(channel)
      if (!listener) throw new Error(`missing listener: ${channel}`)
      listener(...args)
    },
    broadcast,
    save,
    dispose,
    registered: () => ({ handles: handles.size, listeners: listeners.size })
  }
}

describe('settings IPC registration', () => {
  it('serves the snapshot and applies validated patches with a broadcast', () => {
    const h = harness()

    expect(h.invoke(SETTINGS_CHANNELS.get, trustedEvent())).toEqual(defaultAppSettings())

    h.emit(SETTINGS_CHANNELS.set, trustedEvent(), { playbackFps: 16 })
    expect(h.broadcast).toHaveBeenCalledTimes(1)
    expect(h.broadcast).toHaveBeenCalledWith({ ...defaultAppSettings(), playbackFps: 16 })
    expect(h.invoke(SETTINGS_CHANNELS.get, trustedEvent())).toEqual({
      ...defaultAppSettings(),
      playbackFps: 16
    })
  })

  it('broadcasts the unchanged authoritative snapshot for malformed patches', () => {
    const h = harness()
    h.emit(SETTINGS_CHANNELS.set, trustedEvent(), 'not-a-patch')
    expect(h.broadcast).toHaveBeenCalledWith(defaultAppSettings())
    expect(h.save).not.toHaveBeenCalled()
  })

  it('rejects untrusted senders', () => {
    const h = harness()
    expect(() => h.invoke(SETTINGS_CHANNELS.get, foreignEvent())).toThrow(/unavailable/i)
    h.emit(SETTINGS_CHANNELS.set, foreignEvent(), { playbackFps: 2 })
    expect(h.broadcast).not.toHaveBeenCalled()
    expect(h.save).not.toHaveBeenCalled()
  })

  it('registers as one unit and disposal is idempotent', () => {
    const h = harness()
    expect(h.registered()).toEqual({ handles: 1, listeners: 1 })
    h.dispose()
    h.dispose()
    expect(h.registered()).toEqual({ handles: 0, listeners: 0 })
  })

  it('rolls back partial registration on failure', () => {
    const handles = new Map<string, Handler>()
    const ipc: SettingsIpcDependencies['ipc'] = {
      handle: (channel, handler) => void handles.set(channel, handler as Handler),
      removeHandler: (channel) => void handles.delete(channel),
      on: (() => {
        throw new Error('listener registration failed')
      }) as unknown as SettingsIpcDependencies['ipc']['on'],
      removeListener: (() => {}) as SettingsIpcDependencies['ipc']['removeListener']
    }
    const store = createAppSettingsStore({ load: () => null, save: async () => {} })
    expect(() =>
      registerSettingsIpc({
        ipc,
        store,
        isTrustedMainFrame: createRendererMainFrameGate(null),
        broadcast: () => {}
      })
    ).toThrow(/listener registration failed/)
    expect(handles.size).toBe(0)
  })
})
