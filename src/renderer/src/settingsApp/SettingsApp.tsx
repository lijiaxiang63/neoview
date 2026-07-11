import { useEffect, useState, type JSX, type ReactNode } from 'react'
import { NumberField } from '../components/NumberField'
import {
  BRUSH_RADIUS_MAX,
  BRUSH_RADIUS_MIN,
  defaultAppSettings,
  patchAppSettings,
  PLAYBACK_FPS_MAX,
  PLAYBACK_FPS_MIN,
  type AppSettings,
  type AppSettingsPatch
} from '../../../shared/settings'

function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="settings-section">
      <h3>{title}</h3>
      {children}
    </section>
  )
}

function CheckRow({
  label,
  checked,
  disabled,
  onChange
}: {
  label: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}): JSX.Element {
  return (
    <label className="settings-check">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  )
}

/**
 * The settings window's whole UI. Main owns the persisted values: the page
 * loads a snapshot, sends validated patches, and converges on the broadcast
 * authoritative snapshot (edits are applied optimistically with the same
 * shared patch function main uses).
 */
export function SettingsApp(): JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [autoCheck, setAutoCheck] = useState<boolean | null>(null)

  useEffect(() => {
    let live = true
    void window.neoview.getAppSettings().then((snapshot) => {
      if (live) setSettings(snapshot)
    })
    void window.neoview.getUpdateAutoCheck().then((enabled) => {
      if (live) setAutoCheck(enabled)
    })
    const unsubscribe = window.neoview.onAppSettingsChanged((snapshot) => {
      if (live) setSettings(snapshot)
    })
    const unsubscribeAutoCheck = window.neoview.onUpdateAutoCheckChanged((enabled) => {
      if (live) setAutoCheck(enabled)
    })
    return () => {
      live = false
      unsubscribe()
      unsubscribeAutoCheck()
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') window.close()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const apply = (patch: AppSettingsPatch): void => {
    setSettings((current) => (current ? patchAppSettings(current, patch) : current))
    window.neoview.setAppSettings(patch)
  }

  const applyAutoCheck = (enabled: boolean): void => {
    setAutoCheck(enabled)
    window.neoview.setUpdateAutoCheck(enabled)
  }

  const restoreDefaults = (): void => {
    apply(defaultAppSettings())
    applyAutoCheck(true)
  }

  if (!settings) return <div className="settings-page" />

  return (
    <div className="settings-page">
      <Section title="Playback">
        <div className="seg-field">
          <label>Frames per second</label>
          <NumberField
            value={settings.playbackFps}
            min={PLAYBACK_FPS_MIN}
            max={PLAYBACK_FPS_MAX}
            onCommit={(v) => apply({ playbackFps: v })}
            aria-label="Frames per second"
          />
        </div>
      </Section>

      <Section title="Segmentation defaults">
        <div className="seg-field">
          <label>Connectivity</label>
          <div className="preset-row settings-inline">
            {([6, 26] as const).map((c) => (
              <button
                key={c}
                className={`preset-btn${settings.seg.connectivity === c ? ' active' : ''}`}
                onClick={() => apply({ seg: { connectivity: c } })}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
        <div className="seg-field">
          <label>Slab depth (voxels)</label>
          <NumberField
            value={settings.seg.slabDepth}
            min={1}
            onCommit={(v) => apply({ seg: { slabDepth: v } })}
            aria-label="Slab depth"
          />
        </div>
        <div className="seg-field">
          <label>Brush radius (voxels)</label>
          <NumberField
            value={settings.seg.brushRadius}
            min={BRUSH_RADIUS_MIN}
            max={BRUSH_RADIUS_MAX}
            onCommit={(v) => apply({ seg: { brushRadius: v } })}
            aria-label="Brush radius"
          />
        </div>
        <div className="settings-hint">Applied when a volume loads.</div>
      </Section>

      <Section title="Layers">
        <CheckRow
          label="Expand label lists automatically"
          checked={settings.expandLabelLists}
          onChange={(on) => apply({ expandLabelLists: on })}
        />
      </Section>

      <Section title="Updates">
        <CheckRow
          label="Check for updates automatically"
          checked={autoCheck ?? true}
          disabled={autoCheck === null}
          onChange={applyAutoCheck}
        />
      </Section>

      <footer className="settings-footer">
        <button className="preset-btn" onClick={restoreDefaults}>
          Restore Defaults
        </button>
      </footer>
    </div>
  )
}
