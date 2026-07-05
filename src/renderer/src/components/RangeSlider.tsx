import { useRef, type JSX } from 'react'

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

export function RangeSlider({ min, max, lo, hi, onChange }: Props): JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null)
  const span = Math.max(max - min, 1e-12)
  const minGap = span * 1e-6

  const toPct = (v: number): number => ((v - min) / span) * 100
  const clamp = (v: number): number => Math.min(max, Math.max(min, v))

  const startDrag = (e: React.PointerEvent, thumb: 'lo' | 'hi'): void => {
    e.preventDefault()
    e.stopPropagation()
    const track = trackRef.current
    if (!track) return
    const target = e.target as HTMLElement
    target.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent): void => {
      const v = clamp(valueAt(track, ev.clientX, min, span))
      if (thumb === 'lo') onChange(Math.min(v, hi - minGap), hi)
      else onChange(lo, Math.max(v, lo + minGap))
    }
    const up = (): void => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
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
