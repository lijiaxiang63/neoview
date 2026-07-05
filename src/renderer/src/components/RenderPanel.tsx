import { type JSX } from 'react'
import { BRIGHTNESS_MAX, BRIGHTNESS_MIN, DENSITY_MAX, DENSITY_MIN, useStore } from '../store'

export function RenderPanel(): JSX.Element | null {
  const volume = useStore((s) => s.volume)
  const renderMode = useStore((s) => s.renderMode)
  const density = useStore((s) => s.density)
  const brightness = useStore((s) => s.brightness)
  const setRenderMode = useStore((s) => s.setRenderMode)
  const setDensity = useStore((s) => s.setDensity)
  const setBrightness = useStore((s) => s.setBrightness)

  if (!volume) return null

  return (
    <div className="panel-section">
      <h3>Volume rendering</h3>
      <div className="preset-row" style={{ marginTop: 0 }}>
        <button
          className={`preset-btn${renderMode === 'mip' ? ' active' : ''}`}
          onClick={() => setRenderMode('mip')}
        >
          MIP
        </button>
        <button
          className={`preset-btn${renderMode === 'composite' ? ' active' : ''}`}
          onClick={() => setRenderMode('composite')}
        >
          Composite
        </button>
      </div>
      <div className="frame-slider" style={{ marginTop: 10 }}>
        <input
          type="range"
          min={BRIGHTNESS_MIN}
          max={BRIGHTNESS_MAX}
          step={0.01}
          value={brightness}
          onChange={(e) => setBrightness(Number(e.target.value))}
        />
        <span className="frame-label mono">bright {brightness.toFixed(2)}</span>
      </div>
      {renderMode === 'composite' && (
        <div className="frame-slider" style={{ marginTop: 10 }}>
          <input
            type="range"
            min={DENSITY_MIN}
            max={DENSITY_MAX}
            step={0.01}
            value={density}
            onChange={(e) => setDensity(Number(e.target.value))}
          />
          <span className="frame-label mono">density {density.toFixed(2)}</span>
        </div>
      )}
    </div>
  )
}
