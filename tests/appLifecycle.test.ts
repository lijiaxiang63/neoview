import { describe, expect, it } from 'vitest'
import {
  shouldCreateWindowOnActivate,
  shouldQuitAfterAllWindowsClosed
} from '../src/main/appLifecycle'

describe('application window lifecycle', () => {
  it('keeps Windows and Linux alive while the first visible window is pending', () => {
    expect(shouldQuitAfterAllWindowsClosed('win32', true, 0)).toBe(false)
    expect(shouldQuitAfterAllWindowsClosed('linux', true, 0)).toBe(false)
    expect(shouldQuitAfterAllWindowsClosed('win32', false, 0)).toBe(true)
    expect(shouldQuitAfterAllWindowsClosed('linux', false, 0)).toBe(true)
    expect(shouldQuitAfterAllWindowsClosed('linux', false, 1)).toBe(false)
  })

  it('keeps the normal macOS no-window lifetime', () => {
    expect(shouldQuitAfterAllWindowsClosed('darwin', true, 0)).toBe(false)
    expect(shouldQuitAfterAllWindowsClosed('darwin', false, 0)).toBe(false)
  })

  it('creates an activate window only before asynchronous quit starts', () => {
    expect(shouldCreateWindowOnActivate(0, true)).toBe(true)
    expect(shouldCreateWindowOnActivate(1, true)).toBe(false)
    expect(shouldCreateWindowOnActivate(0, false)).toBe(false)
  })
})
