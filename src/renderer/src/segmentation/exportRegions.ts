import type { Volume } from '../volume/types'
import { serializeVolume } from '../volume/parse'
import { gzip } from '../volume/gunzip'
import { buildColorTable, maskUnion, remapForExport, type Region } from './regions'

export type ExportFormat = 'nii.gz' | 'nii'

export interface ExportSettings {
  format: ExportFormat
  /** Absolute directory; '' means "same folder as the opened file". */
  dir: string
}

const FORMAT_KEY = 'neoview.export.format'
const DIR_KEY = 'neoview.export.dir'

export function loadExportSettings(): ExportSettings {
  const format = localStorage.getItem(FORMAT_KEY)
  return {
    format: format === 'nii' ? 'nii' : 'nii.gz',
    dir: localStorage.getItem(DIR_KEY) ?? ''
  }
}

export function saveExportSettings(s: ExportSettings): void {
  localStorage.setItem(FORMAT_KEY, s.format)
  localStorage.setItem(DIR_KEY, s.dir)
}

/** Source name without its volume extension, for deriving output names.
 * Keep in step with folderList.ts#splitDisplayName — the folder panel folds
 * a product into its source row only when the two derive the same stem. */
export function exportBaseName(volumeName: string): string {
  return volumeName.replace(/\.nii(\.gz)?$/i, '').replace(/\.gz$/i, '')
}

/** Directory of an absolute path ('' when there is none to take). Parents
 * that are filesystem roots keep their separator ('/x' -> '/', 'C:\x' ->
 * 'C:\'), since 'C:' alone means the drive's current directory. */
export function dirOfPath(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (cut < 0) return ''
  const dir = path.slice(0, cut)
  return dir === '' || /^[A-Za-z]:$/.test(dir) ? path.slice(0, cut + 1) : dir
}

export interface ExportPayload {
  fileName: string
  bytes: ArrayBuffer
  /** Color table rides along for the label-map variant. */
  sidecar: { fileName: string; text: string } | null
}

async function finishBytes(raw: ArrayBuffer, format: ExportFormat): Promise<ArrayBuffer> {
  return format === 'nii.gz' ? gzip(raw) : raw
}

/** Multi-value label map (one value per region) + color table text. */
export async function buildLabelMapExport(
  base: Volume,
  labelMap: Uint16Array,
  regions: Region[],
  format: ExportFormat
): Promise<ExportPayload> {
  const { data, entries } = remapForExport(labelMap, regions)
  const raw = serializeVolume({
    dims: base.dims,
    spacing: base.spacing,
    affine: base.affine,
    datatypeCode: 512,
    data
  })
  const name = exportBaseName(base.name)
  return {
    fileName: `${name}.regions.${format}`,
    bytes: await finishBytes(raw, format),
    sidecar: { fileName: `${name}.regions.txt`, text: buildColorTable(entries) }
  }
}

/** Single-value mask: 1 wherever any of the given regions has a voxel. */
export async function buildMaskExport(
  base: Volume,
  labelMap: Uint16Array,
  regions: Region[],
  format: ExportFormat
): Promise<ExportPayload> {
  const raw = serializeVolume({
    dims: base.dims,
    spacing: base.spacing,
    affine: base.affine,
    datatypeCode: 2,
    data: maskUnion(labelMap, regions)
  })
  return {
    fileName: `${exportBaseName(base.name)}.mask.${format}`,
    bytes: await finishBytes(raw, format),
    sidecar: null
  }
}
