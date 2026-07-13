// Annotates cluster records with named regions from a reference atlas volume.
// The atlas is runtime data (a label volume plus a name table); this module
// authors no region names of its own. For each cluster it labels the peak voxel
// and tallies the overlapping regions by mapping the cluster's peak and members
// through the atlas affine. Pure.

import { applyAffine, composeVoxelMap } from '../volume/affine'
import type { ClusterMembership, ClusterRecord, ClusterReport } from './clusterReport'
import type { Volume } from '../volume/types'

export interface Atlas {
  volume: Volume
  /** Region names keyed by atlas label id (id 0 is background). */
  names: Map<number, string>
}

/** The em-dash used when a cluster maps outside the atlas or onto background. */
const UNLABELED = '—'

function atlasLabelAt(atlas: Atlas, coord: [number, number, number]): number | null {
  const [ax, ay, az] = atlas.volume.dims
  const xi = Math.round(coord[0])
  const yi = Math.round(coord[1])
  const zi = Math.round(coord[2])
  if (xi < 0 || xi >= ax || yi < 0 || yi >= ay || zi < 0 || zi >= az) return null
  const idx = xi + yi * ax + zi * ax * ay
  return Math.round(atlas.volume.raw[idx] * atlas.volume.slope + atlas.volume.inter)
}

function nameOf(atlas: Atlas, id: number): string {
  if (id === 0) return UNLABELED
  return atlas.names.get(id) ?? `#${id}`
}

/**
 * Annotate each record with its peak region. `statAffine` is the stat map's
 * voxel-to-world matrix; the peak voxel is mapped into atlas voxel space through
 * the composed affine. Mutates the records in place.
 */
export function annotatePeakRegions(
  records: ClusterRecord[],
  statAffine: Float64Array,
  atlas: Atlas
): void {
  const map = composeVoxelMap(statAffine, atlas.volume.affine) // stat voxel → atlas voxel
  if (!map) return
  for (const record of records) {
    const coord = applyAffine(map, record.peakVoxel[0], record.peakVoxel[1], record.peakVoxel[2])
    const id = atlasLabelAt(atlas, coord)
    record.peakRegion = id === null ? UNLABELED : nameOf(atlas, id)
  }
}

/**
 * Additionally tally each cluster's overlapping atlas regions by percentage of
 * cluster voxels, ordered by descending share (matching the reference report).
 * `membership` pairs each record with its cluster's grid voxels (built once at
 * report time), so this walks only surviving voxels and can be re-run for a
 * different atlas without re-labelling. Record `r` owns `membership.voxels`
 * `[offsets[r] .. offsets[r + 1]]`; mutates the records in place.
 */
export function annotateRegionOverlap(
  records: ClusterRecord[],
  membership: ClusterMembership,
  statAffine: Float64Array,
  atlas: Atlas
): void {
  const map = composeVoxelMap(statAffine, atlas.volume.affine)
  if (!map) return
  const { voxels, offsets, dims } = membership
  const nx = dims[0]
  const sz = dims[0] * dims[1]
  records.forEach((record, r) => {
    const end = offsets[r + 1]
    const counts = new Map<number, number>()
    for (let p = offsets[r]; p < end; p++) {
      const idx = voxels[p]
      const k = (idx / sz) | 0
      const rem = idx - k * sz
      const j = (rem / nx) | 0
      const i = rem - j * nx
      const id = atlasLabelAt(atlas, applyAffine(map, i, j, k))
      if (id === null || id === 0) continue
      counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    const total = record.voxelCount
    const parts = [...counts.entries()]
      .map(([id, n]) => ({ name: nameOf(atlas, id), pct: Math.round((100 * n) / total) }))
      .filter((p) => p.pct > 0)
      .sort((a, b) => b.pct - a.pct)
    record.regions =
      parts.length > 0 ? parts.map((p) => `${p.name}(${p.pct}%)`).join('; ') : UNLABELED
  })
}

/** Annotate a report's records with peak region + overlap percentages against
 * `atlas`, in place. `membership` (when present) enables the overlap tally. */
export function annotateReport(
  report: ClusterReport,
  membership: ClusterMembership | null,
  statAffine: Float64Array,
  atlas: Atlas
): void {
  if (report.records.length === 0) return
  annotatePeakRegions(report.records, statAffine, atlas)
  if (membership) annotateRegionOverlap(report.records, membership, statAffine, atlas)
}

/**
 * Produce a fresh report re-annotated against `atlas` (or stripped of region
 * names when `atlas` is null), reusing the retained `membership`. The records
 * are cloned so the result is a new object identity — no correction is re-run.
 */
export function reannotateReport(
  report: ClusterReport,
  membership: ClusterMembership | null,
  statAffine: Float64Array,
  atlas: Atlas | null
): ClusterReport {
  const records = report.records.map((r) => {
    const clone = { ...r }
    delete clone.peakRegion
    delete clone.regions
    return clone
  })
  const next: ClusterReport = { records, keptVoxels: report.keptVoxels }
  if (atlas) annotateReport(next, membership, statAffine, atlas)
  return next
}
