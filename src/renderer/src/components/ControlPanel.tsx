import { type JSX } from 'react'
import { useStore, type Preset } from '../store'
import { RangeSlider } from './RangeSlider'
import { fmt } from '../format'

const PRESETS: { key: Exclude<Preset, 'custom' | 'suggested'>; label: string }[] = [
  { key: 'auto', label: 'Auto' },
  { key: 'full', label: 'Full range' },
  { key: 'fixed-0-80', label: '0 – 80' }
]

export function ControlPanel(): JSX.Element | null {
  const volume = useStore((s) => s.volume)
  const range = useStore((s) => s.range)
  const activePreset = useStore((s) => s.activePreset)
  const setRange = useStore((s) => s.setRange)
  const applyPreset = useStore((s) => s.applyPreset)
  const frame = useStore((s) => s.frame)
  const setFrame = useStore((s) => s.setFrame)

  if (!volume) return null

  const domainMin = Math.min(volume.stats.dataMin, range.lo, 0)
  const domainMax = Math.max(volume.stats.dataMax, range.hi)

  return (
    <div className="panel-section">
      <h3>Display range</h3>
      <RangeSlider
        min={domainMin}
        max={domainMax}
        lo={range.lo}
        hi={range.hi}
        onChange={setRange}
      />
      <div className="range-readout mono">
        <span>{fmt(range.lo)}</span>
        <span>{fmt(range.hi)}</span>
      </div>
      <div className="preset-row">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            className={`preset-btn${activePreset === p.key ? ' active' : ''}`}
            onClick={() => applyPreset(p.key)}
          >
            {p.label}
          </button>
        ))}
        {volume.suggestedRange && (
          <button
            className={`preset-btn${activePreset === 'suggested' ? ' active' : ''}`}
            onClick={() => applyPreset('suggested')}
          >
            File suggested
          </button>
        )}
        {activePreset === 'custom' && <span className="preset-btn active">Custom</span>}
      </div>

      {volume.frames > 1 && (
        <>
          <h3 style={{ marginTop: 18 }}>Frame</h3>
          <div className="frame-slider">
            <input
              type="range"
              min={0}
              max={volume.frames - 1}
              step={1}
              value={frame}
              onChange={(e) => setFrame(Number(e.target.value))}
            />
            <span className="frame-label mono">
              t {frame}/{volume.frames - 1}
            </span>
          </div>
        </>
      )}
    </div>
  )
}
