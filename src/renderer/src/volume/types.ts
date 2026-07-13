export type VoxelArray =
  | Uint8Array
  | Int8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array

export type TransformSource = 'rows' | 'quaternion' | 'spacing-fallback'

/** What the voxel values represent, when the header (or a tool's metadata)
 * declares it: a Student-t, standard-normal (z), F, or p statistic. */
export type StatisticKind = 't' | 'z' | 'f' | 'p'

export interface StatisticInfo {
  kind: StatisticKind
  /** Degrees of freedom (t, F numerator); null when unknown. */
  dof1: number | null
  /** F denominator degrees of freedom; null otherwise. */
  dof2: number | null
}

/** Spatial-smoothness metadata declared by a tool, in a neutral form. */
export interface SmoothnessInfo {
  dLh: number
  fwhm: [number, number, number]
}

export interface VolumeStats {
  /** All in scaled units (raw * slope + inter). */
  dataMin: number
  dataMax: number
  p2: number
  p98: number
  /** Full representable range for integer datatypes, null for floats. */
  typeRange: [number, number] | null
}

export interface Volume {
  name: string
  /** Spatial extent along axes 0/1/2. */
  dims: [number, number, number]
  /** Extent along axis 3 (1 for 3D data). */
  frames: number
  /** Physical size of one voxel along axes 0/1/2. */
  spacing: [number, number, number]
  datatypeCode: number
  datatypeName: string
  raw: VoxelArray
  slope: number
  inter: number
  /** Row-major 4x4 voxel-to-world matrix. */
  affine: Float64Array
  transformSource: TransformSource
  /** Display-range suggestion from the file header, if present. */
  suggestedRange: { lo: number; hi: number } | null
  /** Embedded label-name table keyed by voxel value, if the file carries one. */
  labels: Map<number, string> | null
  /** Statistic descriptor from the header/tool metadata, if declared. */
  statistic: StatisticInfo | null
  /** Spatial-smoothness metadata from a tool, if declared. */
  smoothness: SmoothnessInfo | null
  stats: VolumeStats
}

export class ParseError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'ParseError'
    this.code = code
  }
}
