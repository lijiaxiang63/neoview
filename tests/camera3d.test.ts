import { describe, expect, it } from 'vitest'
import { OrbitCamera, cross, normalize3, type V3 } from '../src/renderer/src/render3d/camera'

const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2])

describe('OrbitCamera', () => {
  it('produces an orthonormal basis', () => {
    const cam = new OrbitCamera()
    cam.rotate(120, -45)
    const { right, up, fwd } = cam.basis()
    expect(len(right)).toBeCloseTo(1)
    expect(len(up)).toBeCloseTo(1)
    expect(len(fwd)).toBeCloseTo(1)
    expect(dot(right, up)).toBeCloseTo(0)
    expect(dot(right, fwd)).toBeCloseTo(0)
    expect(dot(up, fwd)).toBeCloseTo(0)
  })

  it('fwd points from eye toward the origin', () => {
    const cam = new OrbitCamera()
    cam.rotate(300, 80)
    const { eye, fwd } = cam.basis()
    const toOrigin = normalize3([-eye[0], -eye[1], -eye[2]])
    expect(fwd[0]).toBeCloseTo(toOrigin[0])
    expect(fwd[1]).toBeCloseTo(toOrigin[1])
    expect(fwd[2]).toBeCloseTo(toOrigin[2])
  })

  it('clamps pitch to avoid pole flips', () => {
    const cam = new OrbitCamera()
    cam.rotate(0, 100000)
    expect(cam.pitch).toBeLessThanOrEqual(1.55)
    cam.rotate(0, -200000)
    expect(cam.pitch).toBeGreaterThanOrEqual(-1.55)
  })

  it('clamps dolly distance at both ends', () => {
    const cam = new OrbitCamera()
    cam.dolly(1e7)
    expect(cam.dist).toBeLessThanOrEqual(8)
    cam.dolly(-1e7)
    expect(cam.dist).toBeGreaterThanOrEqual(1.2)
  })

  it('reset restores defaults and eye distance matches dist', () => {
    const cam = new OrbitCamera()
    cam.rotate(50, 50)
    cam.dolly(500)
    cam.reset()
    const { eye } = cam.basis()
    expect(len(eye)).toBeCloseTo(cam.dist)
    expect(cam.yaw).toBeCloseTo(0.6)
    expect(cam.pitch).toBeCloseTo(0.35)
    expect(cam.dist).toBeCloseTo(2.5)
  })
})

describe('vec3 helpers', () => {
  it('cross of unit x and y axes gives z', () => {
    expect(cross([1, 0, 0], [0, 1, 0])).toEqual([0, 0, 1])
  })

  it('normalize3 handles the zero vector without NaN', () => {
    const v = normalize3([0, 0, 0])
    for (const c of v) expect(Number.isFinite(c)).toBe(true)
  })
})
