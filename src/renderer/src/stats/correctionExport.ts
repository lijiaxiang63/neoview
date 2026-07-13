// Builds the export products for a corrected stat map: a thresholded float
// volume (surviving voxels keep their original value, the rest are zeroed) and
// the cluster-report CSV sidecar. Pure aside from the async gzip.

import { clusterReportToCsv } from './clusterReport'
import type { SignificanceResult } from './correctionConfig'
import { gzip } from '../volume/gunzip'
import { serializeVolume } from '../volume/parse'
import type { ExportFormat, ExportPayload } from '../segmentation/exportRegions'
import type { Volume } from '../volume/types'

/** Scaled statistic values for surviving voxels of one frame, zero elsewhere. */
export function buildThresholdedMap(
  volume: Volume,
  sig: SignificanceResult,
  frame: number
): Float32Array {
  const [nx, ny, nz] = volume.dims
  const nVox = nx * ny * nz
  const off = Math.min(frame, volume.frames - 1) * nVox
  const { raw, slope, inter } = volume
  const out = new Float32Array(nVox)
  const thr = sig.statThreshold
  const mask = sig.mask
  const isP = sig.kind === 'p'
  const isF = sig.kind === 'f'
  const oneTailed = sig.tail === 'one'
  for (let i = 0; i < nVox; i++) {
    const v = raw[off + i] * slope + inter
    if (v === 0 || !Number.isFinite(v)) continue
    if ((isP && (v <= 0 || v > 1)) || (isF && v <= 0)) continue
    if (mask && mask[i] === 0) continue
    const survives = isP ? v <= thr : oneTailed ? v >= thr : Math.abs(v) >= thr
    if (survives) out[i] = v
  }
  return out
}

/** Corrected-map file bytes plus the cluster-report CSV sidecar. */
export async function buildCorrectedExport(
  volume: Volume,
  sig: SignificanceResult,
  frame: number,
  baseName: string,
  format: ExportFormat
): Promise<ExportPayload> {
  const data = buildThresholdedMap(volume, sig, frame)
  const raw = serializeVolume({
    dims: volume.dims,
    spacing: volume.spacing,
    affine: volume.affine,
    datatypeCode: 16,
    data
  })
  const bytes = format === 'nii.gz' ? await gzip(raw) : raw
  const sidecar =
    sig.report && sig.report.records.length > 0
      ? { fileName: `${baseName}.clusters.csv`, text: clusterReportToCsv(sig.report) }
      : null
  return { fileName: `${baseName}.corrected.${format}`, bytes, sidecar }
}
