import { voxelDirectionFromWorld } from '../volume/affine'

export type V3 = [number, number, number]

export interface CameraBasis {
  eye: V3
  right: V3
  up: V3
  fwd: V3
}

/** Express a world-space camera basis in the volume's signed voxel axes. */
export function cameraBasisForAffine(basis: CameraBasis, affine: Float64Array): CameraBasis {
  return {
    eye: voxelDirectionFromWorld(affine, basis.eye),
    right: voxelDirectionFromWorld(affine, basis.right),
    up: voxelDirectionFromWorld(affine, basis.up),
    fwd: voxelDirectionFromWorld(affine, basis.fwd)
  }
}

export const FOV_Y_RAD = (35 * Math.PI) / 180

const DEFAULT_YAW = 0.6
const DEFAULT_PITCH = 0.35
const DEFAULT_DIST = 2.5

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

export function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

export function normalize3(v: V3): V3 {
  const len = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / len, v[1] / len, v[2] / len]
}

/** Orbit around the volume center (origin), with world axis 2 as up. */
export class OrbitCamera {
  yaw = DEFAULT_YAW
  pitch = DEFAULT_PITCH
  dist = DEFAULT_DIST

  /** dx/dy in CSS pixels. */
  rotate(dx: number, dy: number): void {
    this.yaw += dx * 0.008
    this.pitch = clamp(this.pitch + dy * 0.008, -1.55, 1.55)
  }

  dolly(deltaY: number): void {
    this.dist = clamp(this.dist * Math.exp(deltaY * 0.0012), 1.2, 8)
  }

  reset(): void {
    this.yaw = DEFAULT_YAW
    this.pitch = DEFAULT_PITCH
    this.dist = DEFAULT_DIST
  }

  basis(): CameraBasis {
    const cp = Math.cos(this.pitch)
    const eye: V3 = [
      this.dist * cp * Math.sin(this.yaw),
      this.dist * cp * Math.cos(this.yaw),
      this.dist * Math.sin(this.pitch)
    ]
    const fwd = normalize3([-eye[0], -eye[1], -eye[2]])
    const right = normalize3(cross(fwd, [0, 0, 1]))
    const up = cross(right, fwd)
    return { eye, right, up, fwd }
  }
}
