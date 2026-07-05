import { FRAG_SRC, VERT_SRC } from './shaders'
import { halfExtents } from './normalize'
import type { CameraBasis } from './camera'
import type { RenderMode } from '../store'

export type Quality = 'interactive' | 'full'

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

  /** Retained copy of the last uploaded frame, for context restoration. */
  private lastData: Uint16Array | null = null

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
    if (!this.setup()) return
    if (this.lastData && this.dims) {
      this.uploadTexture(this.lastData, this.dims)
    }
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
    const fs = compile(gl.FRAGMENT_SHADER, FRAG_SRC)
    const prog = gl.createProgram()
    if (!vs || !fs || !prog) {
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
      this.unsupportedReason = 'Could not initialize the 3D renderer.'
      return false
    }
    this.program = prog
    this.vao = gl.createVertexArray()
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
      vol: u('uVol')
    }
    return true
  }

  private uploadTexture(data: Uint16Array, dims: [number, number, number]): boolean {
    const gl = this.gl as WebGL2RenderingContext
    const [nx, ny, nz] = dims
    const maxSize = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) as number
    if (nx > maxSize || ny > maxSize || nz > maxSize) {
      this.unsupportedReason = `Volume exceeds the GPU 3D texture limit (${maxSize}).`
      return false
    }
    if (this.tex) gl.deleteTexture(this.tex)
    this.tex = gl.createTexture()
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

  setVolume(
    data: Uint16Array,
    dims: [number, number, number],
    spacing: [number, number, number]
  ): void {
    if (!this.gl || this.unsupportedReason || this.contextLost) return
    this.dims = [...dims]
    this.halfExt = halfExtents(dims, spacing)
    this.lastData = data
    const maxDim = Math.max(dims[0], dims[1], dims[2])
    this.fullSteps = Math.min(512, Math.max(128, Math.ceil(1.5 * maxDim)))
    this.uploadTexture(data, this.dims)
  }

  /** Replace texel data for the current dims (4D frame change). */
  setFrameData(data: Uint16Array): void {
    if (!this.gl || !this.tex || !this.dims || this.unsupportedReason || this.contextLost) return
    const gl = this.gl
    this.lastData = data
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

    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  dispose(): void {
    this.canvas.removeEventListener('webglcontextlost', this.handleLost)
    this.canvas.removeEventListener('webglcontextrestored', this.handleRestored)
    const gl = this.gl
    if (!gl) return
    if (this.tex) gl.deleteTexture(this.tex)
    if (this.program) gl.deleteProgram(this.program)
    if (this.vao) gl.deleteVertexArray(this.vao)
    this.gl = null
    this.lastData = null
  }
}
