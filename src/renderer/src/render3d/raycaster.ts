import { FRAG_SRC, VERT_SRC } from './shaders'
import { halfExtents } from './normalize'
import type { CameraBasis } from './camera'
import type { Quality, RenderMode } from './types'

interface Uniforms {
  eye: WebGLUniformLocation | null
  right: WebGLUniformLocation | null
  up: WebGLUniformLocation | null
  fwd: WebGLUniformLocation | null
  halfExt: WebGLUniformLocation | null
  viewport: WebGLUniformLocation | null
  tanHalfFov: WebGLUniformLocation | null
  aspect: WebGLUniformLocation | null
  lo: WebGLUniformLocation | null
  hi: WebGLUniformLocation | null
  bright: WebGLUniformLocation | null
  density: WebGLUniformLocation | null
  mode: WebGLUniformLocation | null
  steps: WebGLUniformLocation | null
  vol: WebGLUniformLocation | null
  lab: WebGLUniformLocation | null
  labLut: WebGLUniformLocation | null
  hasLab: WebGLUniformLocation | null
  labAlpha: WebGLUniformLocation | null
}

/**
 * WebGL2 single-pass volume raycaster over a fullscreen triangle.
 * Pure GL lifecycle — owns no scheduling; callers decide when to render().
 */
export class Raycaster {
  private gl: WebGL2RenderingContext | null = null
  private program: WebGLProgram | null = null
  private vao: WebGLVertexArrayObject | null = null
  private tex: WebGLTexture | null = null
  private uni: Uniforms | null = null
  private contextLost = false
  private recoverableTextureUnsupported = false

  private dims: [number, number, number] | null = null
  private halfExt: [number, number, number] = [0.5, 0.5, 0.5]
  private basis: CameraBasis | null = null
  private tanHalfFov = Math.tan(0.3)
  private windowLo = 0
  private windowHi = 1
  private brightness = 0.45
  private mode: RenderMode = 'mip'
  private density = 0.35
  private fullSteps = 256

  // Region overlay: palette-index 3D texture + 256-entry color LUT.
  private labTex: WebGLTexture | null = null
  private labLutTex: WebGLTexture | null = null
  private labAlpha = 0.5

  unsupportedReason: string | null = null
  onContextRestored: (() => void) | null = null

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      depth: false,
      stencil: false,
      antialias: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance'
    })
    if (!gl) {
      this.unsupportedReason = 'WebGL2 is not available on this device.'
      return
    }
    this.gl = gl

    canvas.addEventListener('webglcontextlost', this.handleLost)
    canvas.addEventListener('webglcontextrestored', this.handleRestored)

    if (!this.setup()) return
  }

  private handleLost = (e: Event): void => {
    e.preventDefault()
    this.contextLost = true
  }

  private handleRestored = (): void => {
    this.contextLost = false
    // The lost context's texture handles are dead; forget them so the
    // re-uploads below create fresh ones instead of deleting stale handles.
    this.tex = null
    this.labTex = null
    this.labLutTex = null
    this.program = null
    this.vao = null
    this.uni = null
    this.unsupportedReason = null
    this.recoverableTextureUnsupported = false
    this.setup()
    this.onContextRestored?.()
  }

  /** Compile program, create VAO. Returns false (and sets unsupportedReason) on failure. */
  private setup(): boolean {
    const gl = this.gl as WebGL2RenderingContext
    const compile = (type: number, src: string): WebGLShader | null => {
      const sh = gl.createShader(type)
      if (!sh) return null
      gl.shaderSource(sh, src)
      gl.compileShader(sh)
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.error('shader compile failed:', gl.getShaderInfoLog(sh))
        gl.deleteShader(sh)
        return null
      }
      return sh
    }
    const vs = compile(gl.VERTEX_SHADER, VERT_SRC)
    if (!vs) {
      this.unsupportedReason = 'Could not initialize the 3D renderer.'
      return false
    }
    const fs = compile(gl.FRAGMENT_SHADER, FRAG_SRC)
    if (!fs) {
      gl.deleteShader(vs)
      this.unsupportedReason = 'Could not initialize the 3D renderer.'
      return false
    }
    const prog = gl.createProgram()
    if (!prog) {
      gl.deleteShader(vs)
      gl.deleteShader(fs)
      this.unsupportedReason = 'Could not initialize the 3D renderer.'
      return false
    }
    gl.attachShader(prog, vs)
    gl.attachShader(prog, fs)
    gl.linkProgram(prog)
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('program link failed:', gl.getProgramInfoLog(prog))
      gl.deleteProgram(prog)
      this.unsupportedReason = 'Could not initialize the 3D renderer.'
      return false
    }
    const vao = gl.createVertexArray()
    if (!vao) {
      gl.deleteProgram(prog)
      this.unsupportedReason = 'Could not initialize the 3D renderer.'
      return false
    }
    this.program = prog
    this.vao = vao
    const u = (name: string): WebGLUniformLocation | null => gl.getUniformLocation(prog, name)
    this.uni = {
      eye: u('uEye'),
      right: u('uRight'),
      up: u('uUp'),
      fwd: u('uFwd'),
      halfExt: u('uHalfExt'),
      viewport: u('uViewport'),
      tanHalfFov: u('uTanHalfFov'),
      aspect: u('uAspect'),
      lo: u('uLo'),
      hi: u('uHi'),
      bright: u('uBright'),
      density: u('uDensity'),
      mode: u('uMode'),
      steps: u('uSteps'),
      vol: u('uVol'),
      lab: u('uLab'),
      labLut: u('uLabLut'),
      hasLab: u('uHasLab'),
      labAlpha: u('uLabAlpha')
    }
    return true
  }

  /** Upload the region palette-index texture (dims must match the volume). */
  private uploadLabelTexture(data: Uint8Array): void {
    const gl = this.gl as WebGL2RenderingContext
    if (!this.dims) return
    const [nx, ny, nz] = this.dims
    if (this.labTex) gl.deleteTexture(this.labTex)
    const texture = gl.createTexture()
    if (!texture) {
      this.labTex = null
      this.unsupportedReason = 'Could not allocate a GPU texture.'
      this.recoverableTextureUnsupported = true
      return
    }
    this.labTex = texture
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_3D, this.labTex)
    gl.texStorage3D(gl.TEXTURE_3D, 1, gl.R8, nx, ny, nz)
    gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, 0, nx, ny, nz, gl.RED, gl.UNSIGNED_BYTE, data)
    // NEAREST: palette indices must never interpolate across regions.
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAX_LEVEL, 0)
  }

  private uploadLabelLut(rgba: Uint8Array): void {
    const gl = this.gl as WebGL2RenderingContext
    if (!this.labLutTex) {
      const texture = gl.createTexture()
      if (!texture) {
        this.unsupportedReason = 'Could not allocate a GPU texture.'
        this.recoverableTextureUnsupported = true
        return
      }
      this.labLutTex = texture
    }
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, this.labLutTex)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  }

  private uploadTexture(data: Uint16Array, dims: [number, number, number]): boolean {
    const gl = this.gl as WebGL2RenderingContext
    const [nx, ny, nz] = dims
    const maxSize = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) as number
    if (nx > maxSize || ny > maxSize || nz > maxSize) {
      this.unsupportedReason = `Volume exceeds the GPU 3D texture limit (${maxSize}).`
      this.recoverableTextureUnsupported = true
      return false
    }
    const texture = gl.createTexture()
    if (!texture) {
      this.unsupportedReason = 'Could not allocate a GPU texture.'
      this.recoverableTextureUnsupported = true
      return false
    }
    this.tex = texture
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_3D, this.tex)
    gl.texStorage3D(gl.TEXTURE_3D, 1, gl.R16F, nx, ny, nz)
    // Half-float payload matches R16F exactly, so the driver memcpy's the
    // upload instead of converting hundreds of MB of float32 on the CPU.
    gl.texSubImage3D(gl.TEXTURE_3D, 0, 0, 0, 0, nx, ny, nz, gl.RED, gl.HALF_FLOAT, data)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAX_LEVEL, 0)
    return true
  }

  /** Release textures whose grid belongs to the outgoing volume. */
  private clearGridTextures(): void {
    const gl = this.gl
    if (!gl) return
    if (this.tex) gl.deleteTexture(this.tex)
    if (this.labTex) gl.deleteTexture(this.labTex)
    this.tex = null
    this.labTex = null
  }

  setVolume(
    data: Uint16Array,
    dims: [number, number, number],
    spacing: [number, number, number]
  ): void {
    if (!this.gl || (this.unsupportedReason && !this.recoverableTextureUnsupported)) return
    if (this.recoverableTextureUnsupported) {
      this.recoverableTextureUnsupported = false
      this.unsupportedReason = null
    }
    if (!this.contextLost) this.clearGridTextures()
    this.dims = [...dims]
    this.halfExt = halfExtents(dims, spacing)
    const maxDim = Math.max(dims[0], dims[1], dims[2])
    this.fullSteps = Math.min(512, Math.max(128, Math.ceil(1.5 * maxDim)))
    if (!this.contextLost) this.uploadTexture(data, this.dims)
  }

  /**
   * Region palette-index texture over the SAME grid as the current volume
   * texture (built with the same plan); null removes the region layer.
   */
  setLabelVolume(data: Uint8Array | null): void {
    if (!this.gl || this.unsupportedReason) return
    if (this.contextLost) return
    if (!data) {
      if (this.labTex) {
        this.gl.deleteTexture(this.labTex)
        this.labTex = null
      }
      return
    }
    this.uploadLabelTexture(data)
  }

  /** 256-entry RGBA palette (index 0 unused); alpha 0 hides a region. */
  setLabelLut(rgba: Uint8Array): void {
    if (!this.gl || this.unsupportedReason) return
    if (this.contextLost) return
    this.uploadLabelLut(rgba)
  }

  setLabelAlpha(a: number): void {
    this.labAlpha = a
  }

  /** Replace texel data for the current dims (4D frame change). */
  setFrameData(data: Uint16Array): void {
    if (!this.gl || !this.dims || this.unsupportedReason) return
    if (this.contextLost || !this.tex) return
    const gl = this.gl
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_3D, this.tex)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texSubImage3D(
      gl.TEXTURE_3D,
      0,
      0,
      0,
      0,
      this.dims[0],
      this.dims[1],
      this.dims[2],
      gl.RED,
      gl.HALF_FLOAT,
      data
    )
  }

  setWindow(loN: number, hiN: number): void {
    this.windowLo = loN
    this.windowHi = hiN
  }

  setMode(mode: RenderMode): void {
    this.mode = mode
  }

  setDensity(d: number): void {
    this.density = d
  }

  setBrightness(b: number): void {
    this.brightness = b
  }

  setCamera(basis: CameraBasis, fovYRad: number): void {
    this.basis = basis
    this.tanHalfFov = Math.tan(fovYRad / 2)
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    const w = Math.max(1, Math.round(cssW * dpr))
    const h = Math.max(1, Math.round(cssH * dpr))
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
    }
  }

  render(quality: Quality): void {
    const gl = this.gl
    if (!gl || !this.program || !this.uni || !this.tex || !this.basis) return
    if (this.unsupportedReason || this.contextLost) return
    const w = this.canvas.width
    const h = this.canvas.height
    if (w === 0 || h === 0) return

    gl.viewport(0, 0, w, h)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.useProgram(this.program)
    gl.bindVertexArray(this.vao)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_3D, this.tex)
    const hasLab = this.labTex !== null && this.labLutTex !== null
    if (hasLab) {
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_3D, this.labTex)
      gl.activeTexture(gl.TEXTURE2)
      gl.bindTexture(gl.TEXTURE_2D, this.labLutTex)
    }

    const u = this.uni
    const b = this.basis
    gl.uniform3fv(u.eye, b.eye)
    gl.uniform3fv(u.right, b.right)
    gl.uniform3fv(u.up, b.up)
    gl.uniform3fv(u.fwd, b.fwd)
    gl.uniform3fv(u.halfExt, this.halfExt)
    gl.uniform2f(u.viewport, w, h)
    gl.uniform1f(u.tanHalfFov, this.tanHalfFov)
    gl.uniform1f(u.aspect, w / h)
    gl.uniform1f(u.lo, this.windowLo)
    gl.uniform1f(u.hi, Math.max(this.windowHi, this.windowLo + 1e-6))
    gl.uniform1f(u.bright, this.brightness)
    gl.uniform1f(u.density, this.density)
    gl.uniform1i(u.mode, this.mode === 'mip' ? 0 : 1)
    // Interactive quality quarters the step count; start jitter hides the
    // banding, and the win is what keeps long drags fluid on weaker GPUs.
    gl.uniform1i(u.steps, quality === 'full' ? this.fullSteps : Math.max(64, this.fullSteps >> 2))
    gl.uniform1i(u.vol, 0)
    gl.uniform1i(u.lab, 1)
    gl.uniform1i(u.labLut, 2)
    gl.uniform1i(u.hasLab, hasLab ? 1 : 0)
    gl.uniform1f(u.labAlpha, this.labAlpha)

    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  dispose(): void {
    this.canvas.removeEventListener('webglcontextlost', this.handleLost)
    this.canvas.removeEventListener('webglcontextrestored', this.handleRestored)
    const gl = this.gl
    if (!gl) return
    if (this.tex) gl.deleteTexture(this.tex)
    if (this.labTex) gl.deleteTexture(this.labTex)
    if (this.labLutTex) gl.deleteTexture(this.labLutTex)
    if (this.program) gl.deleteProgram(this.program)
    if (this.vao) gl.deleteVertexArray(this.vao)
    this.gl = null
  }
}
