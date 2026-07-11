import { useEffect, useState, type JSX } from 'react'
import { useStore, type BaseColormap, type Preset } from '../store'
import { RangeSlider } from './RangeSlider'
import { NumberField } from './NumberField'
import { fmt } from '../format'
import { playbackFrameTarget } from '../runtime/appEvents'

const PRESETS: { key: Exclude<Preset, 'custom' | 'suggested'>; label: string }[] = [
  { key: 'auto', label: 'Auto' },
  { key: 'full', label: 'Full range' },
  { key: 'fixed-0-80', label: '0 – 80' }
]

const COLORMAPS: { key: BaseColormap; label: string }[] = [
  { key: 'gray', label: 'Gray' },
  { key: 'warm', label: 'Warm' },
  { key: 'cool', label: 'Cool' }
]

const PLAYBACK_FPS = 8

/** Loop the frame slider while playing; any volume change stops playback. */
function FrameControls(): JSX.Element {
  const volume = useStore((s) => s.volume)!
  const volumeSession = useStore((s) => s.volumeSession)
  const frame = useStore((s) => s.frame)
  const setFrame = useStore((s) => s.setFrame)
  // Retain only a small store session, never the volume/raw buffer it names.
  const [playingSession, setPlayingSession] = useState<number | null>(null)
  const playing = playingSession === volumeSession
  const setPlaying = (value: boolean): void => setPlayingSession(value ? volumeSession : null)
  useEffect(() => {
    if (!playing) return
    const playbackSession = volumeSession
    const id = setInterval(() => {
      const s = useStore.getState()
      const frame = playbackFrameTarget(s, playbackSession)
      if (frame !== null) s.setFrame(frame)
    }, 1000 / PLAYBACK_FPS)
    return () => {
      clearInterval(id)
      const s = useStore.getState()
      if (s.volumeSession === playbackSession) s.refreshRegionStats()
    }
  }, [playing, volumeSession])

  return (
    <>
      <h3 style={{ marginTop: 18 }}>Frame</h3>
      <div className="frame-slider">
        <button
          className="play-btn"
          title={playing ? 'Pause' : 'Play frames in a loop'}
          aria-label={playing ? 'Pause' : 'Play'}
          aria-pressed={playing}
          onClick={() => setPlaying(!playing)}
        >
          {playing ? (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M2 1h2.4v8H2zM5.6 1H8v8H5.6z" fill="currentColor" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M2 1l7 4-7 4z" fill="currentColor" />
            </svg>
          )}
        </button>
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
  )
}

export function ControlPanel(): JSX.Element | null {
  const volume = useStore((s) => s.volume)
  const range = useStore((s) => s.range)
  const activePreset = useStore((s) => s.activePreset)
  const baseColormap = useStore((s) => s.baseColormap)
  const setRange = useStore((s) => s.setRange)
  const applyPreset = useStore((s) => s.applyPreset)
  const setBaseColormap = useStore((s) => s.setBaseColormap)

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
      <div className="range-readout">
        <NumberField
          aria-label="Display range low"
          value={range.lo}
          format={fmt}
          onCommit={(v) => setRange(Math.min(v, range.hi), range.hi)}
        />
        <NumberField
          aria-label="Display range high"
          value={range.hi}
          format={fmt}
          onCommit={(v) => setRange(range.lo, Math.max(v, range.lo))}
        />
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

      <div className="seg-field">
        <label>Colormap</label>
        <div className="preset-row" style={{ marginTop: 0 }}>
          {COLORMAPS.map((c) => (
            <button
              key={c.key}
              className={`preset-btn${baseColormap === c.key ? ' active' : ''}`}
              title="Slice-view colormap for the base volume"
              onClick={() => setBaseColormap(c.key)}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {volume.frames > 1 && <FrameControls />}
    </div>
  )
}
