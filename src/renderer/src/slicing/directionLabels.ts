import type { PlaneSpec } from './extract'
import { worldAxesForVoxelAxes, type SpatialAxis } from '../volume/affine'

export type DirectionLabel = 'L' | 'R' | 'A' | 'P' | 'S' | 'I'

export interface SliceDirectionLabels {
  left: DirectionLabel
  right: DirectionLabel
  top: DirectionLabel
  bottom: DirectionLabel
}

const POSITIVE: readonly DirectionLabel[] = ['R', 'A', 'S']
const NEGATIVE: readonly DirectionLabel[] = ['L', 'P', 'I']
interface ViewAxes {
  sliceWorldAxis: SpatialAxis
  colWorldAxis: SpatialAxis
  rowWorldAxis: SpatialAxis
  colWorldDirection: 1 | -1
  label: string
}

const VIEW_AXES: readonly ViewAxes[] = [
  { sliceWorldAxis: 2, colWorldAxis: 0, rowWorldAxis: 1, colWorldDirection: -1, label: 'Plane XY' },
  { sliceWorldAxis: 1, colWorldAxis: 0, rowWorldAxis: 2, colWorldDirection: -1, label: 'Plane XZ' },
  { sliceWorldAxis: 0, colWorldAxis: 1, rowWorldAxis: 2, colWorldDirection: 1, label: 'Plane YZ' }
]

function rawDirectionForWorldDirection(
  affine: Float64Array,
  voxelAxis: SpatialAxis,
  worldAxis: SpatialAxis,
  worldDirection: 1 | -1
): 1 | -1 {
  return (affine[worldAxis * 4 + voxelAxis] >= 0 ? worldDirection : -worldDirection) as 1 | -1
}

/** Build three world-aligned plane specifications without copying the volume. */
export function slicePlanesForAffine(
  affine: Float64Array
): readonly [PlaneSpec, PlaneSpec, PlaneSpec] {
  const worldForVoxel = worldAxesForVoxelAxes(affine)
  const voxelForWorld = [0, 0, 0] as [SpatialAxis, SpatialAxis, SpatialAxis]
  for (
    let voxelAxis = 0 as SpatialAxis;
    voxelAxis < 3;
    voxelAxis = (voxelAxis + 1) as SpatialAxis
  ) {
    voxelForWorld[worldForVoxel[voxelAxis]] = voxelAxis
  }
  const planeFor = (view: ViewAxes): PlaneSpec => {
    const colAxis = voxelForWorld[view.colWorldAxis]
    const rowAxis = voxelForWorld[view.rowWorldAxis]
    return {
      sliceAxis: voxelForWorld[view.sliceWorldAxis],
      colAxis,
      rowAxis,
      colDirection: rawDirectionForWorldDirection(
        affine,
        colAxis,
        view.colWorldAxis,
        view.colWorldDirection
      ),
      rowDirection: rawDirectionForWorldDirection(affine, rowAxis, view.rowWorldAxis, 1),
      label: view.label
    }
  }
  return [planeFor(VIEW_AXES[0]), planeFor(VIEW_AXES[1]), planeFor(VIEW_AXES[2])]
}

function labelForVoxelDirection(
  affine: Float64Array,
  voxelAxis: 0 | 1 | 2,
  increasing: boolean,
  worldAxes: readonly [number, number, number]
): DirectionLabel {
  const worldAxis = worldAxes[voxelAxis]
  const component = affine[worldAxis * 4 + voxelAxis]
  const positive = increasing ? component >= 0 : component < 0
  return (positive ? POSITIVE : NEGATIVE)[worldAxis]
}

export function sliceDirectionLabels(
  affine: Float64Array,
  plane: Pick<PlaneSpec, 'colAxis' | 'rowAxis' | 'colDirection' | 'rowDirection'>
): SliceDirectionLabels {
  const worldAxes = worldAxesForVoxelAxes(affine)
  return {
    left: labelForVoxelDirection(affine, plane.colAxis, plane.colDirection < 0, worldAxes),
    right: labelForVoxelDirection(affine, plane.colAxis, plane.colDirection > 0, worldAxes),
    top: labelForVoxelDirection(affine, plane.rowAxis, plane.rowDirection > 0, worldAxes),
    bottom: labelForVoxelDirection(affine, plane.rowAxis, plane.rowDirection < 0, worldAxes)
  }
}
