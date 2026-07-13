import { buildAffine } from './affine'
import { computeStats } from './stats'
import {
  ParseError,
  type SmoothnessInfo,
  type StatisticInfo,
  type StatisticKind,
  type Volume,
  type VoxelArray
} from './types'

// 348-byte v1 header byte offsets (spec identifiers, not user-facing).
const OFF_SIZEOF_HDR = 0
const OFF_INTENT_P1 = 56
const OFF_INTENT_P2 = 60
const OFF_DIM = 40
const OFF_INTENT_CODE = 68
const OFF_DATATYPE = 70
const OFF_BITPIX = 72
const OFF_PIXDIM = 76
const OFF_VOX_OFFSET = 108
const OFF_SCL_SLOPE = 112
const OFF_SCL_INTER = 116
const OFF_CAL_MAX = 124
const OFF_CAL_MIN = 128
const OFF_DESCRIP = 148
const DESCRIP_SIZE = 80
const OFF_QFORM_CODE = 252
const OFF_SFORM_CODE = 254
const OFF_QUATERN = 256
const OFF_QOFFSET = 268
const OFF_SROW_X = 280
const OFF_SROW_Y = 296
const OFF_SROW_Z = 312
const OFF_MAGIC = 344

const HEADER_SIZE = 348
const MIN_FILE_SIZE = 352
const INTENT_LABEL = 1002

// NIfTI-1 statistic intent codes → neutral kind. intent_p1/p2 carry the degrees
// of freedom for the parameterized ones.
const STAT_INTENT_KINDS: Record<number, StatisticKind> = {
  3: 't', // Student-t: p1 = dof
  4: 'f', // F: p1 = numerator dof, p2 = denominator dof
  5: 'z', // standard normal
  22: 'p' // p-value
}

/** Metadata some tools embed in the 80-byte description field, of the form
 * `<tool>{T_[dof]}{dLh_<value>}{FWHMx_<x> FWHMy_<y> FWHMz_<z> mm}`. */
const DESCRIP_META_RE =
  /\{T_\[([0-9.]+)\]\}(?:\{dLh_([0-9.eE+-]+)\})?(?:\{FWHMx_([0-9.]+)\s+FWHMy_([0-9.]+)\s+FWHMz_([0-9.]+)\s*mm\})?/

interface DatatypeInfo {
  ctor: new (buf: ArrayBuffer, byteOffset?: number, length?: number) => VoxelArray
  bytes: number
  name: string
}

const DATATYPES: Record<number, DatatypeInfo> = {
  2: { ctor: Uint8Array, bytes: 1, name: 'uint8' },
  4: { ctor: Int16Array, bytes: 2, name: 'int16' },
  8: { ctor: Int32Array, bytes: 4, name: 'int32' },
  16: { ctor: Float32Array, bytes: 4, name: 'float32' },
  64: { ctor: Float64Array, bytes: 8, name: 'float64' },
  256: { ctor: Int8Array, bytes: 1, name: 'int8' },
  512: { ctor: Uint16Array, bytes: 2, name: 'uint16' },
  768: { ctor: Uint32Array, bytes: 4, name: 'uint32' }
}

function swapBytesInPlace(bytes: Uint8Array, width: number): void {
  for (let i = 0; i < bytes.length; i += width) {
    for (let a = 0, b = width - 1; a < b; a++, b--) {
      const t = bytes[i + a]
      bytes[i + a] = bytes[i + b]
      bytes[i + b] = t
    }
  }
}

/**
 * Embedded label table. When a file is flagged as a label volume (intent code
 * 1002) and its data offset leaves a gap after the 348-byte header, that gap
 * holds a plain "index<TAB>name" text table — one entry per line, keyed by
 * voxel value. It is deliberately *not* a formal header extension: the 4
 * extension-flag bytes stay zero, so a strict reader simply seeks past the gap
 * to the voxel data and ignores it. Returns null when no such table is present.
 */
export function parseLabelTable(buf: ArrayBuffer): Map<number, string> | null {
  if (buf.byteLength < MIN_FILE_SIZE) return null
  const dv = new DataView(buf)

  let le = true
  if (dv.getInt32(OFF_SIZEOF_HDR, true) !== HEADER_SIZE) {
    if (dv.getInt32(OFF_SIZEOF_HDR, false) !== HEADER_SIZE) return null
    le = false
  }

  if (dv.getInt16(OFF_INTENT_CODE, le) !== INTENT_LABEL) return null
  // A non-zero extension flag means [352, dataOffset) is a formal extension
  // list, not raw label text — this convention doesn't apply.
  if (dv.getUint8(HEADER_SIZE) !== 0) return null

  const dataOffset = Math.round(dv.getFloat32(OFF_VOX_OFFSET, le))
  if (dataOffset <= MIN_FILE_SIZE || dataOffset > buf.byteLength) return null

  let text = new TextDecoder('latin1').decode(
    new Uint8Array(buf, MIN_FILE_SIZE, dataOffset - MIN_FILE_SIZE)
  )
  // The gap is often padded to an aligned data offset with NULs — cut there.
  const nul = text.indexOf('\0')
  if (nul !== -1) text = text.slice(0, nul)

  const labels = new Map<number, string>()
  for (const line of text.split('\n')) {
    // "<index><TAB><name>[<TAB>extra…]"; some files append a colour column.
    // Fall back to whitespace splitting for space-delimited variants.
    const cols = line.includes('\t') ? line.split('\t') : line.trim().split(/\s+/)
    if (cols.length < 2) continue
    const index = Number(cols[0])
    const name = cols[1].trim()
    if (Number.isInteger(index) && name) labels.set(index, name)
  }
  return labels.size > 0 ? labels : null
}

export interface SerializeOptions {
  dims: [number, number, number]
  spacing: [number, number, number]
  /** Row-major 4x4 voxel-to-world matrix; its three rows are written out. */
  affine: Float64Array
  /** 2 (uint8), 512 (uint16), or 16 (float32). */
  datatypeCode: 2 | 512 | 16
  data: Uint8Array | Uint16Array | Float32Array
}

/**
 * Build a complete single-file volume buffer (uncompressed): 348-byte v1
 * header, little-endian, matrix-rows transform, data at offset 352. The
 * inverse of parseVolume for the subset this app writes (3D integer or float32
 * data, identity value scaling).
 */
export function serializeVolume(opts: SerializeOptions): ArrayBuffer {
  const dtype = DATATYPES[opts.datatypeCode]
  const [nx, ny, nz] = opts.dims
  if (opts.data.length !== nx * ny * nz) {
    throw new Error('Data length does not match the volume extent.')
  }
  const buf = new ArrayBuffer(MIN_FILE_SIZE + opts.data.length * dtype.bytes)
  const dv = new DataView(buf)

  dv.setInt32(OFF_SIZEOF_HDR, HEADER_SIZE, true)
  dv.setInt16(OFF_DIM, 3, true)
  const dims = [nx, ny, nz, 1, 1, 1, 1]
  for (let i = 0; i < 7; i++) dv.setInt16(OFF_DIM + 2 + i * 2, dims[i], true)
  dv.setInt16(OFF_DATATYPE, opts.datatypeCode, true)
  dv.setInt16(OFF_BITPIX, dtype.bytes * 8, true)
  dv.setFloat32(OFF_PIXDIM, 1, true) // qfac
  for (let i = 0; i < 3; i++) dv.setFloat32(OFF_PIXDIM + 4 + i * 4, opts.spacing[i], true)
  dv.setFloat32(OFF_VOX_OFFSET, MIN_FILE_SIZE, true)
  dv.setFloat32(OFF_SCL_SLOPE, 1, true)
  dv.setFloat32(OFF_SCL_INTER, 0, true)
  dv.setInt16(OFF_QFORM_CODE, 0, true)
  dv.setInt16(OFF_SFORM_CODE, 1, true)
  const rowOffsets = [OFF_SROW_X, OFF_SROW_Y, OFF_SROW_Z]
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      dv.setFloat32(rowOffsets[r] + c * 4, opts.affine[r * 4 + c], true)
    }
  }
  dv.setUint8(OFF_MAGIC, 0x6e) // n
  dv.setUint8(OFF_MAGIC + 1, 0x2b) // +
  dv.setUint8(OFF_MAGIC + 2, 0x31) // 1
  dv.setUint8(OFF_MAGIC + 3, 0)

  if (opts.data instanceof Float32Array) {
    new Float32Array(buf, MIN_FILE_SIZE, opts.data.length).set(opts.data)
  } else if (opts.data instanceof Uint16Array) {
    new Uint16Array(buf, MIN_FILE_SIZE, opts.data.length).set(opts.data)
  } else {
    new Uint8Array(buf, MIN_FILE_SIZE, opts.data.length).set(opts.data)
  }
  return buf
}

function readDescrip(dv: DataView): string {
  let text = new TextDecoder('latin1').decode(
    new Uint8Array(dv.buffer, dv.byteOffset + OFF_DESCRIP, DESCRIP_SIZE)
  )
  const nul = text.indexOf('\0')
  if (nul !== -1) text = text.slice(0, nul)
  return text
}

function positiveOrNull(v: number): number | null {
  return Number.isFinite(v) && v > 0 ? v : null
}

/**
 * Neutral statistic + smoothness descriptors from the header: NIfTI intent
 * fields first, refined by any tool metadata embedded in the description field
 * (`<tool>{T_[dof]}{dLh_…}{FWHMx_… mm}`). The raw field names stay confined here.
 */
function parseStatMetadata(
  dv: DataView,
  le: boolean
): { statistic: StatisticInfo | null; smoothness: SmoothnessInfo | null } {
  let descripDof: number | null = null
  let smoothness: SmoothnessInfo | null = null
  const meta = DESCRIP_META_RE.exec(readDescrip(dv))
  if (meta) {
    descripDof = positiveOrNull(Number(meta[1]))
    if (meta[2] !== undefined) {
      const dLh = Number(meta[2])
      if (Number.isFinite(dLh) && dLh > 0) {
        const fwhm: [number, number, number] =
          meta[3] !== undefined
            ? [Number(meta[3]), Number(meta[4]), Number(meta[5])]
            : [0, 0, 0]
        smoothness = { dLh, fwhm }
      }
    }
  }

  const kind = STAT_INTENT_KINDS[dv.getInt16(OFF_INTENT_CODE, le)] ?? null
  let statistic: StatisticInfo | null = null
  if (kind) {
    let dof1 = kind === 't' || kind === 'f' ? positiveOrNull(dv.getFloat32(OFF_INTENT_P1, le)) : null
    const dof2 = kind === 'f' ? positiveOrNull(dv.getFloat32(OFF_INTENT_P2, le)) : null
    if (kind === 't' && dof1 === null) dof1 = descripDof
    statistic = { kind, dof1, dof2 }
  } else if (descripDof !== null) {
    statistic = { kind: 't', dof1: descripDof, dof2: null }
  }
  return { statistic, smoothness }
}

export function parseVolume(name: string, buf: ArrayBuffer): Volume {
  if (buf.byteLength < MIN_FILE_SIZE) {
    throw new ParseError('too-small', 'File is too small to contain a valid header.')
  }
  const dv = new DataView(buf)

  let le = true
  if (dv.getInt32(OFF_SIZEOF_HDR, true) !== HEADER_SIZE) {
    if (dv.getInt32(OFF_SIZEOF_HDR, false) === HEADER_SIZE) {
      le = false
    } else {
      throw new ParseError('bad-header', 'Unrecognized header.')
    }
  }

  const magic = String.fromCharCode(
    dv.getUint8(OFF_MAGIC),
    dv.getUint8(OFF_MAGIC + 1),
    dv.getUint8(OFF_MAGIC + 2)
  )
  if (magic === 'ni1') {
    throw new ParseError(
      'two-file',
      'Two-file layout is not supported; use a single-file .nii instead.'
    )
  }
  if (magic !== 'n+1') {
    throw new ParseError('bad-magic', 'Unrecognized file signature.')
  }

  const dim: number[] = []
  for (let i = 0; i < 8; i++) dim.push(dv.getInt16(OFF_DIM + i * 2, le))
  const ndim = dim[0]
  if (ndim < 1 || ndim > 7) {
    throw new ParseError('bad-dim', `Invalid dimension count (${ndim}).`)
  }
  const nx = Math.max(1, dim[1])
  const ny = ndim >= 2 ? Math.max(1, dim[2]) : 1
  const nz = ndim >= 3 ? Math.max(1, dim[3]) : 1
  const nt = ndim >= 4 ? Math.max(1, dim[4]) : 1
  for (let i = 5; i <= ndim; i++) {
    if (dim[i] > 1) {
      throw new ParseError('extra-dims', 'Data with more than 4 dimensions is not supported.')
    }
  }

  const datatypeCode = dv.getInt16(OFF_DATATYPE, le)
  const dtype = DATATYPES[datatypeCode]
  if (!dtype) {
    throw new ParseError('bad-datatype', `Unsupported voxel datatype (code ${datatypeCode}).`)
  }
  const bitpix = dv.getInt16(OFF_BITPIX, le)
  if (bitpix !== dtype.bytes * 8) {
    console.warn(`bitpix ${bitpix} does not match datatype ${dtype.name}; trusting datatype`)
  }

  const pixdim: number[] = []
  for (let i = 0; i < 8; i++) pixdim.push(dv.getFloat32(OFF_PIXDIM + i * 4, le))
  const finiteSpacing = (value: number): number => {
    const magnitude = Math.abs(value)
    return Number.isFinite(magnitude) ? Math.max(magnitude, 1e-6) : 1e-6
  }
  const spacing: [number, number, number] = [
    finiteSpacing(pixdim[1]),
    finiteSpacing(pixdim[2]),
    finiteSpacing(pixdim[3])
  ]

  const rawOffset = dv.getFloat32(OFF_VOX_OFFSET, le)
  if (!Number.isFinite(rawOffset)) {
    throw new ParseError('bad-offset', 'Invalid data offset.')
  }
  const voxOffset = Math.max(MIN_FILE_SIZE, Math.round(rawOffset))
  const voxelCount = nx * ny * nz * nt
  const needed = voxelCount * dtype.bytes
  if (voxOffset + needed > buf.byteLength) {
    throw new ParseError('truncated', 'Data section is truncated.')
  }

  let raw: VoxelArray
  if (le && voxOffset % dtype.bytes === 0) {
    // Aligned little-endian data: view straight into the file buffer,
    // skipping a multi-tens-of-MB copy on large volumes.
    raw = new dtype.ctor(buf, voxOffset, voxelCount)
  } else {
    const dataBuf = buf.slice(voxOffset, voxOffset + needed)
    if (!le && dtype.bytes > 1) {
      swapBytesInPlace(new Uint8Array(dataBuf), dtype.bytes)
    }
    raw = new dtype.ctor(dataBuf)
  }

  let slope = dv.getFloat32(OFF_SCL_SLOPE, le)
  if (!Number.isFinite(slope) || slope === 0) slope = 1
  let inter = dv.getFloat32(OFF_SCL_INTER, le)
  if (!Number.isFinite(inter)) inter = 0

  const srow: [Float64Array, Float64Array, Float64Array] = [
    new Float64Array(4),
    new Float64Array(4),
    new Float64Array(4)
  ]
  for (let c = 0; c < 4; c++) {
    srow[0][c] = dv.getFloat32(OFF_SROW_X + c * 4, le)
    srow[1][c] = dv.getFloat32(OFF_SROW_Y + c * 4, le)
    srow[2][c] = dv.getFloat32(OFF_SROW_Z + c * 4, le)
  }
  const { m: affine, source: transformSource } = buildAffine({
    rowTransformAvailable: dv.getInt16(OFF_SFORM_CODE, le) > 0,
    rotationTransformAvailable: dv.getInt16(OFF_QFORM_CODE, le) > 0,
    rows: srow,
    rotation: [
      dv.getFloat32(OFF_QUATERN, le),
      dv.getFloat32(OFF_QUATERN + 4, le),
      dv.getFloat32(OFF_QUATERN + 8, le)
    ],
    translation: [
      dv.getFloat32(OFF_QOFFSET, le),
      dv.getFloat32(OFF_QOFFSET + 4, le),
      dv.getFloat32(OFF_QOFFSET + 8, le)
    ],
    thirdAxisSign: pixdim[0],
    spacing
  })

  const calMax = dv.getFloat32(OFF_CAL_MAX, le)
  const calMin = dv.getFloat32(OFF_CAL_MIN, le)
  const suggestedRange =
    Number.isFinite(calMin) && Number.isFinite(calMax) && calMin < calMax
      ? { lo: calMin, hi: calMax }
      : null

  const stats = computeStats(raw, slope, inter, datatypeCode)
  const { statistic, smoothness } = parseStatMetadata(dv, le)

  return {
    name,
    dims: [nx, ny, nz],
    frames: nt,
    spacing,
    datatypeCode,
    datatypeName: dtype.name,
    raw,
    slope,
    inter,
    affine,
    transformSource,
    suggestedRange,
    labels: parseLabelTable(buf),
    statistic,
    smoothness,
    stats
  }
}
