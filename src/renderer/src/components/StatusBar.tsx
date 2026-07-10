import { type JSX } from 'react'
import { useStore } from '../store'
import { applyAffine } from '../volume/affine'
import { strides } from '../slicing/extract'
import { sampleOverlayAt, type OverlayLayer } from '../slicing/overlay'
import type { Volume } from '../volume/types'

function fmt(v: number, digits = 1): string {
  return Number(v.toFixed(digits)).toString()
}

/** Strip the volume extension so layer readout labels stay short. */
function shortName(name: string): string {
  return name.replace(/(\.nii\.gz|\.nii)$/i, '')
}

function layerReadout(
  layer: OverlayLayer,
  base: Volume,
  ijk: [number, number, number],
  frame: number
): string {
  const v = sampleOverlayAt(layer, base, ijk, frame)
  if (v === null) return '—'
  if (layer.kind === 'labels') {
    const id = Math.round(v)
    return layer.volume.labels?.get(id) ?? `id ${id}`
  }
  return fmt(v, 4)
}

export function StatusBar(): JSX.Element {
  const volume = useStore((s) => s.volume)
  const hover = useStore((s) => s.hover)
  const cross = useStore((s) => s.cross)
  const frame = useStore((s) => s.frame)
  const overlays = useStore((s) => s.overlays)
  const labelMap = useStore((s) => s.labelMap)
  const regions = useStore((s) => s.regions)
  // Subscribed so brush strokes refresh the readout even though labelMap
  // mutates in place.
  useStore((s) => s.labelMapRev)

  if (!volume) {
    return <div className="status-bar">Ready</div>
  }

  const ijk = hover ? hover.ijk : cross
  const [i, j, k] = ijk
  const [x, y, z] = applyAffine(volume.affine, i, j, k)
  const st = strides(volume.dims)
  const frameStride = volume.dims[0] * volume.dims[1] * volume.dims[2]
  const raw = volume.raw[i * st[0] + j * st[1] + k * st[2] + frame * frameStride]
  const scaled = raw * volume.slope + volume.inter
  const hasScaling = volume.slope !== 1 || volume.inter !== 0

  return (
    <div className="status-bar mono">
      <span className="field">
        <span className="label">{hover ? 'cursor' : 'cross'}</span>
        <span className="value">
          i {i} · j {j} · k {k}
        </span>
      </span>
      <span className="field">
        <span className="label">world</span>
        <span className="value">
          x {fmt(x)} · y {fmt(y)} · z {fmt(z)}
        </span>
      </span>
      {hasScaling && (
        <span className="field">
          <span className="label">raw</span>
          <span className="value">{fmt(raw, 4)}</span>
        </span>
      )}
      <span className="field">
        <span className="label">value</span>
        <span className="value">{fmt(scaled, 4)}</span>
      </span>
      {labelMap && regions.length > 0 && (
        <span className="field">
          <span className="label">region</span>
          <span className="value">
            {regions.find((r) => r.id === labelMap[i * st[0] + j * st[1] + k * st[2]])?.name ?? '—'}
          </span>
        </span>
      )}
      {overlays.map((layer) => (
        <span key={layer.id} className={`field layer-field${layer.visible ? '' : ' muted'}`}>
          <span className="label" title={layer.volume.name}>
            {shortName(layer.volume.name)}
          </span>
          <span className="value">{layerReadout(layer, volume, ijk, frame)}</span>
        </span>
      ))}
      {volume.frames > 1 && (
        <span className="field">
          <span className="label">t</span>
          <span className="value">{frame}</span>
        </span>
      )}
    </div>
  )
}
