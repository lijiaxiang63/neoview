import { describe, expect, it, vi } from 'vitest'
import { Raycaster } from '../src/renderer/src/render3d/raycaster'

function harness(
  limit: number,
  options: { shaderResults?: boolean[]; linkResult?: boolean; textureResults?: boolean[] } = {}
): {
  raycaster: Raycaster
  upload: ReturnType<typeof vi.fn>
  deleteTexture: ReturnType<typeof vi.fn>
  deleteShader: ReturnType<typeof vi.fn>
  deleteProgram: ReturnType<typeof vi.fn>
  dispose(): void
} {
  const upload = vi.fn()
  const deleteTexture = vi.fn()
  const deleteShader = vi.fn()
  const deleteProgram = vi.fn()
  const shaderResults = [...(options.shaderResults ?? [true, true])]
  const textureResults = [...(options.textureResults ?? [])]
  let nextResource = 1
  const gl = {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    COMPILE_STATUS: 3,
    LINK_STATUS: 4,
    MAX_3D_TEXTURE_SIZE: 5,
    TEXTURE0: 6,
    TEXTURE1: 7,
    TEXTURE2: 8,
    TEXTURE_3D: 9,
    TEXTURE_2D: 10,
    R16F: 11,
    R8: 12,
    RGBA8: 13,
    RED: 14,
    RGBA: 15,
    HALF_FLOAT: 16,
    UNSIGNED_BYTE: 17,
    TEXTURE_MIN_FILTER: 18,
    TEXTURE_MAG_FILTER: 19,
    LINEAR: 20,
    NEAREST: 21,
    TEXTURE_WRAP_S: 22,
    TEXTURE_WRAP_T: 23,
    TEXTURE_WRAP_R: 24,
    CLAMP_TO_EDGE: 25,
    TEXTURE_MAX_LEVEL: 26,
    UNPACK_ALIGNMENT: 27,
    createShader: () => ({ kind: 'shader', id: nextResource++ }),
    shaderSource: () => undefined,
    compileShader: () => undefined,
    getShaderParameter: () => shaderResults.shift() ?? true,
    getShaderInfoLog: () => '',
    deleteShader,
    createProgram: () => ({ kind: 'program', id: nextResource++ }),
    attachShader: () => undefined,
    linkProgram: () => undefined,
    getProgramParameter: () => options.linkResult ?? true,
    getProgramInfoLog: () => '',
    deleteProgram,
    createVertexArray: () => ({ kind: 'vertex-array', id: nextResource++ }),
    deleteVertexArray: () => undefined,
    getUniformLocation: () => null,
    getParameter: () => limit,
    createTexture: () =>
      (textureResults.shift() ?? true) ? { kind: 'texture', id: nextResource++ } : null,
    deleteTexture,
    pixelStorei: () => undefined,
    activeTexture: () => undefined,
    bindTexture: () => undefined,
    texStorage3D: () => undefined,
    texSubImage3D: upload,
    texImage2D: () => undefined,
    texParameteri: () => undefined
  }
  const listeners = new Map<string, EventListener>()
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => gl,
    addEventListener: (type: string, listener: EventListener) => void listeners.set(type, listener),
    removeEventListener: (type: string, listener: EventListener) => {
      if (listeners.get(type) === listener) listeners.delete(type)
    }
  }
  const raycaster = new Raycaster(canvas as unknown as HTMLCanvasElement)
  return {
    raycaster,
    upload,
    deleteTexture,
    deleteShader,
    deleteProgram,
    dispose: () => raycaster.dispose()
  }
}

describe('Raycaster volume limits', () => {
  it('recovers when a supported volume replaces one over the texture limit', () => {
    const h = harness(4)
    try {
      h.raycaster.setVolume(new Uint16Array(5), [5, 1, 1], [1, 1, 1])
      expect(h.raycaster.unsupportedReason).toContain('texture limit')
      expect(h.upload).not.toHaveBeenCalled()

      h.raycaster.setVolume(new Uint16Array(4), [4, 1, 1], [1, 1, 1])
      expect(h.raycaster.unsupportedReason).toBeNull()
      expect(h.upload).toHaveBeenCalledTimes(1)
    } finally {
      h.dispose()
    }
  })

  it('releases the previous volume and label textures before rejecting a replacement', () => {
    const h = harness(4)
    try {
      h.raycaster.setVolume(new Uint16Array(4), [4, 1, 1], [1, 1, 1])
      h.raycaster.setLabelVolume(new Uint8Array(4))
      h.deleteTexture.mockClear()

      h.raycaster.setVolume(new Uint16Array(5), [5, 1, 1], [1, 1, 1])

      expect(h.raycaster.unsupportedReason).toContain('texture limit')
      expect(h.deleteTexture).toHaveBeenCalledTimes(2)
    } finally {
      h.dispose()
    }
  })

  it('reports a failed base texture allocation instead of silently succeeding', () => {
    const h = harness(4, { textureResults: [false] })
    try {
      h.raycaster.setVolume(new Uint16Array(4), [4, 1, 1], [1, 1, 1])
      expect(h.raycaster.unsupportedReason).toContain('allocate')
      expect(h.upload).not.toHaveBeenCalled()

      h.raycaster.setVolume(new Uint16Array(4), [4, 1, 1], [1, 1, 1])
      expect(h.raycaster.unsupportedReason).toBeNull()
      expect(h.upload).toHaveBeenCalledTimes(1)
    } finally {
      h.dispose()
    }
  })

  it('reports a failed label texture allocation', () => {
    const h = harness(4, { textureResults: [true, false] })
    try {
      h.raycaster.setVolume(new Uint16Array(4), [4, 1, 1], [1, 1, 1])
      h.raycaster.setLabelVolume(new Uint8Array(4))
      expect(h.raycaster.unsupportedReason).toContain('allocate')
    } finally {
      h.dispose()
    }
  })
})

describe('Raycaster setup cleanup', () => {
  it('deletes a compiled peer shader when the other shader fails', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const h = harness(4, { shaderResults: [true, false] })
    try {
      expect(h.raycaster.unsupportedReason).toContain('initialize')
      expect(h.deleteShader).toHaveBeenCalledTimes(2)
    } finally {
      h.dispose()
      error.mockRestore()
    }
  })

  it('deletes a program that fails to link', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const h = harness(4, { linkResult: false })
    try {
      expect(h.raycaster.unsupportedReason).toContain('initialize')
      expect(h.deleteProgram).toHaveBeenCalledTimes(1)
    } finally {
      h.dispose()
      error.mockRestore()
    }
  })
})
