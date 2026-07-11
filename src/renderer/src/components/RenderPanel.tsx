import { type JSX } from 'react'
import { BRIGHTNESS_MAX, BRIGHTNESS_MIN, DENSITY_MAX, DENSITY_MIN, useStore } from '../store'
import { NumberField } from './NumberField'
import { CollapsibleSection } from './CollapsibleSection'

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
      <CollapsibleSection title="Volume rendering" persistId="display.render">
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
        <div className="seg-field">
          <label>Brightness</label>
          <input
            type="range"
            min={BRIGHTNESS_MIN}
            max={BRIGHTNESS_MAX}
            step={0.01}
            value={brightness}
            onChange={(e) => setBrightness(Number(e.target.value))}
          />
          <NumberField
            aria-label="Brightness"
            value={brightness}
            min={BRIGHTNESS_MIN}
            max={BRIGHTNESS_MAX}
            format={(v) => v.toFixed(2)}
            onCommit={setBrightness}
          />
        </div>
        {renderMode === 'composite' && (
          <div className="seg-field">
            <label>Density</label>
            <input
              type="range"
              min={DENSITY_MIN}
              max={DENSITY_MAX}
              step={0.01}
              value={density}
              onChange={(e) => setDensity(Number(e.target.value))}
            />
            <NumberField
              aria-label="Density"
              value={density}
              min={DENSITY_MIN}
              max={DENSITY_MAX}
              format={(v) => v.toFixed(2)}
              onCommit={setDensity}
            />
          </div>
        )}
      </CollapsibleSection>
    </div>
  )
}
