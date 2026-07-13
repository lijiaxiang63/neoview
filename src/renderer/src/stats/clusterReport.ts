// Cluster report: per-cluster geometry and peak, plus a neutral CSV serializer.
// Coordinates are voxel indices and affine-derived world coordinates — no named
// regions here (region annotation is layered on separately). Pure.

import { applyAffine } from '../volume/affine'

import type { Components } from './connectedComponents'

export interface ClusterRecord {
  /** 1-based rank, clusters ordered largest first. */
  id: number
  voxelCount: number
  /** Physical volume in world units (voxelCount × voxel volume). */
  volumeWorld: number
  /** Signed original statistic at the peak voxel. */
  peakStat: number
  /** Peak voxel index on the map grid. */
  peakVoxel: [number, number, number]
  /** Peak world coordinate via the map affine. */
  peakWorld: [number, number, number]
  /** Peak region name from an atlas, if annotated. */
  peakRegion?: string
  /** Overlapping region names with percentages, if annotated. */
  regions?: string
}

export interface ClusterReport {
  records: ClusterRecord[]
  /** Total voxels across the kept clusters. */
  keptVoxels: number
}

/**
 * Compact per-record voxel membership retained alongside a report so a report
 * can be re-annotated against a different atlas without re-running correction.
 * CSR layout: record `r` (i.e. `records[r]`, id `r+1`) owns the grid voxel
 * indices `voxels[offsets[r] .. offsets[r + 1]]`. Only kept-cluster voxels are
 * stored, so this is far smaller than a whole-grid labelling.
 */
export interface ClusterMembership {
  dims: [number, number, number]
  voxels: Int32Array
  /** Length `records.length + 1`; prefix offsets into `voxels`. */
  offsets: Int32Array
}

/**
 * Build the compact membership pairing each report record with its cluster's
 * voxels. Records are renumbered by size, so each is matched back to its
 * original component label via its peak voxel — never assuming id == label.
 */
export function buildMembership(
  report: ClusterReport,
  components: Components,
  dims: [number, number, number]
): ClusterMembership {
  const { records } = report
  const nRec = records.length
  const nx = dims[0]
  const sz = dims[0] * dims[1]
  const { labels } = components

  // Original component label → record index (0-based), via each peak voxel.
  const labelToRec = new Map<number, number>()
  records.forEach((r, i) => {
    labelToRec.set(labels[r.peakVoxel[0] + r.peakVoxel[1] * nx + r.peakVoxel[2] * sz], i)
  })

  const offsets = new Int32Array(nRec + 1)
  for (let idx = 0; idx < labels.length; idx++) {
    const label = labels[idx]
    if (label === 0) continue
    const rec = labelToRec.get(label)
    if (rec !== undefined) offsets[rec + 1]++
  }
  for (let i = 0; i < nRec; i++) offsets[i + 1] += offsets[i]

  const voxels = new Int32Array(offsets[nRec])
  const cursor = offsets.slice(0, nRec)
  for (let idx = 0; idx < labels.length; idx++) {
    const label = labels[idx]
    if (label === 0) continue
    const rec = labelToRec.get(label)
    if (rec !== undefined) voxels[cursor[rec]++] = idx
  }
  return { dims, voxels, offsets }
}

/** Absolute determinant of the affine's upper 3×3 = one voxel's world volume. */
function voxelVolume(affine: Float64Array): number {
  const det =
    affine[0] * (affine[5] * affine[10] - affine[6] * affine[9]) -
    affine[1] * (affine[4] * affine[10] - affine[6] * affine[8]) +
    affine[2] * (affine[4] * affine[9] - affine[5] * affine[8])
  if (Math.abs(det) >= 1e-12) return Math.abs(det)
  // Degenerate affine: fall back to the product of the column magnitudes.
  const c0 = Math.hypot(affine[0], affine[4], affine[8])
  const c1 = Math.hypot(affine[1], affine[5], affine[9])
  const c2 = Math.hypot(affine[2], affine[6], affine[10])
  return c0 * c1 * c2
}

/**
 * Build the cluster report from a labelling of the surviving voxels. `values`
 * holds the original statistic. Peaks use maximum magnitude by default; p-value
 * maps request the minimum value instead. Clusters smaller than
 * `minClusterSize` are dropped; the rest are ordered largest first and
 * renumbered 1..N.
 */
export function buildClusterReport(
  values: Float64Array,
  dims: [number, number, number],
  affine: Float64Array,
  components: Components,
  minClusterSize: number,
  peakMode: 'magnitude' | 'minimum' = 'magnitude'
): ClusterReport {
  const nx = dims[0]
  const sz = dims[0] * dims[1]
  const { labels, sizes, count } = components
  const peakIdx = new Int32Array(count).fill(-1)
  const peakAbs = new Float64Array(count)

  for (let idx = 0; idx < labels.length; idx++) {
    const label = labels[idx]
    if (label === 0) continue
    const c = label - 1
    const score = peakMode === 'minimum' ? -values[idx] : Math.abs(values[idx])
    if (peakIdx[c] === -1 || score > peakAbs[c]) {
      peakAbs[c] = score
      peakIdx[c] = idx
    }
  }

  const vox = voxelVolume(affine)
  const records: ClusterRecord[] = []
  for (let c = 0; c < count; c++) {
    const voxelCount = sizes[c]
    if (voxelCount < minClusterSize) continue
    const idx = peakIdx[c]
    const k = (idx / sz) | 0
    const rem = idx - k * sz
    const j = (rem / nx) | 0
    const i = rem - j * nx
    records.push({
      id: 0,
      voxelCount,
      volumeWorld: voxelCount * vox,
      peakStat: values[idx],
      peakVoxel: [i, j, k],
      peakWorld: applyAffine(affine, i, j, k)
    })
  }

  records.sort((a, b) => b.voxelCount - a.voxelCount)
  let keptVoxels = 0
  records.forEach((record, index) => {
    record.id = index + 1
    keptVoxels += record.voxelCount
  })
  return { records, keptVoxels }
}

function num(value: number, digits: number): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '0'
}

/** Serialize a report to CSV. Columns are neutral; region columns appear only
 * when the records were annotated. */
export function clusterReportToCsv(report: ClusterReport): string {
  const annotated = report.records.some(
    (r) => r.peakRegion !== undefined || r.regions !== undefined
  )
  const header = ['cluster', 'voxels', 'volume', 'peak', 'i', 'j', 'k', 'x', 'y', 'z']
  if (annotated) header.push('peak_region', 'regions')
  const lines = [header.join(',')]
  for (const r of report.records) {
    const cols = [
      String(r.id),
      String(r.voxelCount),
      num(r.volumeWorld, 2),
      num(r.peakStat, 4),
      String(r.peakVoxel[0]),
      String(r.peakVoxel[1]),
      String(r.peakVoxel[2]),
      num(r.peakWorld[0], 2),
      num(r.peakWorld[1], 2),
      num(r.peakWorld[2], 2)
    ]
    if (annotated) {
      cols.push(csvCell(r.peakRegion ?? '—'), csvCell(r.regions ?? '—'))
    }
    lines.push(cols.join(','))
  }
  return lines.join('\n') + '\n'
}

/** Quote a CSV cell if it contains a comma, quote, or newline. */
function csvCell(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}
