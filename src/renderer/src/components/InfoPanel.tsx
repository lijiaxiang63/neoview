import { type JSX } from 'react'
import { useStore } from '../store'
import type { TransformSource } from '../volume/types'

const SOURCE_LABELS: Record<TransformSource, string> = {
  rows: 'matrix rows',
  quaternion: 'quaternion',
  'spacing-fallback': 'spacing fallback'
}

function fmtCell(v: number): string {
  if (Object.is(v, -0)) v = 0
  const abs = Math.abs(v)
  if (v !== 0 && (abs >= 10000 || abs < 0.001)) return v.toExponential(1)
  return Number(v.toFixed(3)).toString()
}

function fmtSpacing(v: number): string {
  return Number(v.toFixed(4)).toString()
}

export function InfoPanel(): JSX.Element | null {
  const volume = useStore((s) => s.volume)
  if (!volume) return null

  const cells: JSX.Element[] = []
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const v = r === 3 ? (c === 3 ? 1 : 0) : volume.affine[r * 4 + c]
      cells.push(
        <div key={`${r}-${c}`} className={`cell mono${c === 3 && r < 3 ? ' translation' : ''}`}>
          {fmtCell(v)}
        </div>
      )
    }
  }

  return (
    <>
      <div className="panel-section">
        <h3>Volume</h3>
        <dl className="info-grid">
          <dt>Dimensions</dt>
          <dd className="mono">
            {volume.dims[0]} × {volume.dims[1]} × {volume.dims[2]}
            {volume.frames > 1 ? ` × ${volume.frames}` : ''}
          </dd>
          <dt>Spacing</dt>
          <dd className="mono">
            {fmtSpacing(volume.spacing[0])} × {fmtSpacing(volume.spacing[1])} ×{' '}
            {fmtSpacing(volume.spacing[2])}
          </dd>
          <dt>Datatype</dt>
          <dd className="mono">{volume.datatypeName}</dd>
          {(volume.slope !== 1 || volume.inter !== 0) && (
            <>
              <dt>Value scaling</dt>
              <dd className="mono">
                × {volume.slope} + {volume.inter}
              </dd>
            </>
          )}
          <dt>Value range</dt>
          <dd className="mono">
            {Number(volume.stats.dataMin.toFixed(2))} … {Number(volume.stats.dataMax.toFixed(2))}
          </dd>
        </dl>
      </div>
      <div className="panel-section">
        <h3>Affine</h3>
        <span className="transform-pill">{SOURCE_LABELS[volume.transformSource]}</span>
        <div className="affine-grid">{cells}</div>
      </div>
    </>
  )
}
