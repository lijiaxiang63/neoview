import { useEffect, useRef, useState, type JSX } from 'react'

interface Props {
  min: number
  max: number
  lo: number
  hi: number
  onChange: (lo: number, hi: number) => void
}

function valueAt(track: HTMLElement, clientX: number, min: number, span: number): number {
  const rect = track.getBoundingClientRect()
  const t = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
  return min + t * span
}

export interface RangePointerTarget {
  setPointerCapture(pointerId: number): void
  releasePointerCapture(pointerId: number): void
  addEventListener(type: string, listener: EventListener): void
  removeEventListener(type: string, listener: EventListener): void
}

/** One-thumb native pointer lifecycle, kept DOM-light for cancellation tests. */
export class RangeSliderDragController {
  private active: {
    target: RangePointerTarget
    pointerId: number
    move: EventListener
    end: EventListener
  } | null = null

  start(target: RangePointerTarget, pointerId: number, onMove: (clientX: number) => void): boolean {
    if (this.active) return false
    try {
      target.setPointerCapture(pointerId)
    } catch {
      return false
    }
    const move: EventListener = (event) => {
      const pointer = event as PointerEvent
      if (pointer.pointerId === pointerId) onMove(pointer.clientX)
    }
    const end: EventListener = (event) => {
      if ((event as PointerEvent).pointerId === pointerId) this.finish(pointerId)
    }
    this.active = { target, pointerId, move, end }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', end)
    target.addEventListener('pointercancel', end)
    target.addEventListener('lostpointercapture', end)
    return true
  }

  finish(pointerId?: number): void {
    const active = this.active
    if (!active || (pointerId !== undefined && active.pointerId !== pointerId)) return
    this.active = null
    active.target.removeEventListener('pointermove', active.move)
    active.target.removeEventListener('pointerup', active.end)
    active.target.removeEventListener('pointercancel', active.end)
    active.target.removeEventListener('lostpointercapture', active.end)
    try {
      active.target.releasePointerCapture(active.pointerId)
    } catch {
      // Capture may already have been released by the platform.
    }
  }

  dispose(): void {
    this.finish()
  }
}

export function RangeSlider({ min, max, lo, hi, onChange }: Props): JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null)
  const [drag] = useState(() => new RangeSliderDragController())
  useEffect(() => () => drag.dispose(), [drag])
  const span = Math.max(max - min, 1e-12)
  const minGap = span * 1e-6

  const toPct = (v: number): number => ((v - min) / span) * 100
  const clamp = (v: number): number => Math.min(max, Math.max(min, v))

  const startDrag = (e: React.PointerEvent, thumb: 'lo' | 'hi'): void => {
    e.preventDefault()
    e.stopPropagation()
    const track = trackRef.current
    if (!track) return
    drag.start(e.currentTarget, e.pointerId, (clientX) => {
      const v = clamp(valueAt(track, clientX, min, span))
      if (thumb === 'lo') onChange(Math.min(v, hi - minGap), hi)
      else onChange(lo, Math.max(v, lo + minGap))
    })
  }

  const onTrackDown = (e: React.PointerEvent): void => {
    const track = trackRef.current
    if (!track) return
    const v = clamp(valueAt(track, e.clientX, min, span))
    // Move whichever thumb is closer.
    if (Math.abs(v - lo) <= Math.abs(v - hi)) onChange(Math.min(v, hi - minGap), hi)
    else onChange(lo, Math.max(v, lo + minGap))
  }

  const nudge = (e: React.KeyboardEvent, thumb: 'lo' | 'hi'): void => {
    const step = span / 200
    let d = 0
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') d = -step
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') d = step
    else return
    e.preventDefault()
    if (thumb === 'lo') onChange(clamp(Math.min(lo + d, hi - minGap)), hi)
    else onChange(lo, clamp(Math.max(hi + d, lo + minGap)))
  }

  return (
    <div className="range-slider" onPointerDown={onTrackDown}>
      <div ref={trackRef} className="track" />
      <div className="fill" style={{ left: `${toPct(lo)}%`, width: `${toPct(hi) - toPct(lo)}%` }} />
      <div
        className="thumb"
        style={{ left: `${toPct(lo)}%` }}
        tabIndex={0}
        role="slider"
        aria-label="Display range low"
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={lo}
        onPointerDown={(e) => startDrag(e, 'lo')}
        onKeyDown={(e) => nudge(e, 'lo')}
      />
      <div
        className="thumb"
        style={{ left: `${toPct(hi)}%` }}
        tabIndex={0}
        role="slider"
        aria-label="Display range high"
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={hi}
        onPointerDown={(e) => startDrag(e, 'hi')}
        onKeyDown={(e) => nudge(e, 'hi')}
      />
    </div>
  )
}
