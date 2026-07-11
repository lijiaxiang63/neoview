import type { Volume } from '../volume/types'
import { serializeVolume } from '../volume/parse'
import { gzip } from '../volume/gunzip'
import { buildColorTable, maskUnion, remapForExport, type Region } from './regions'
import type { ExportRequest } from '../../../shared/files'
import { PERSISTED_STORAGE_KEYS } from '../../../shared/storageMigration'

export type ExportFormat = 'nii.gz' | 'nii'

export interface ExportSettings {
  format: ExportFormat
  /** Absolute directory; '' means "same folder as the opened file". */
  dir: string
}

const FORMAT_KEY = PERSISTED_STORAGE_KEYS[1]
const DIR_KEY = PERSISTED_STORAGE_KEYS[2]

type ExportStorage = Pick<Storage, 'getItem' | 'setItem'>

export function loadExportSettings(
  storage: Pick<ExportStorage, 'getItem'> = localStorage
): ExportSettings {
  try {
    const format = storage.getItem(FORMAT_KEY)
    return {
      format: format === 'nii' ? 'nii' : 'nii.gz',
      dir: storage.getItem(DIR_KEY) ?? ''
    }
  } catch {
    return { format: 'nii.gz', dir: '' }
  }
}

export function saveExportSettings(
  settings: ExportSettings,
  storage: Pick<ExportStorage, 'setItem'> = localStorage
): void {
  try {
    storage.setItem(FORMAT_KEY, settings.format)
    storage.setItem(DIR_KEY, settings.dir)
  } catch {
    // Preference persistence is best-effort; exporting remains available.
  }
}

/** Source name without its volume extension, for deriving output names.
 * Strips exactly ONE extension with the same alternation as folderList.ts#
 * splitDisplayName — the folder panel folds a product into its source row
 * only when the two derive the same stem. */
export function exportBaseName(volumeName: string): string {
  return volumeName.replace(/(\.nii\.gz|\.nii)$/i, '')
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

export type ExportPayload = Omit<ExportRequest, 'dir'>
export type ExportVolume = Pick<Volume, 'name' | 'dims' | 'spacing' | 'affine'>

async function finishBytes(raw: ArrayBuffer, format: ExportFormat): Promise<ArrayBuffer> {
  return format === 'nii.gz' ? gzip(raw) : raw
}

/** Multi-value label map (one value per region) + color table text. */
export async function buildLabelMapExport(
  base: ExportVolume,
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
  base: ExportVolume,
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
