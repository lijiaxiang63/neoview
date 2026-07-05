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
