import type { PlaneSpec } from './extract'

export type DirectionLabel = 'L' | 'R' | 'A' | 'P' | 'S' | 'I'

export interface SliceDirectionLabels {
  left: DirectionLabel
  right: DirectionLabel
  top: DirectionLabel
  bottom: DirectionLabel
}

const POSITIVE: readonly DirectionLabel[] = ['R', 'A', 'S']
const NEGATIVE: readonly DirectionLabel[] = ['L', 'P', 'I']
const PERMUTATIONS: readonly (readonly [number, number, number])[] = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0]
]

/** Assign each voxel axis to one distinct world axis, choosing the mapping
 * with the strongest affine-column alignment. */
function worldAxesForVoxelAxes(affine: Float64Array): readonly [number, number, number] {
  const columnLengths = [0, 1, 2].map((voxelAxis) =>
    Math.hypot(affine[voxelAxis], affine[4 + voxelAxis], affine[8 + voxelAxis])
  )
  let best = PERMUTATIONS[0]
  let bestScore = -1
  for (const candidate of PERMUTATIONS) {
    const score = candidate.reduce(
      (sum, worldAxis, voxelAxis) =>
        sum + Math.abs(affine[worldAxis * 4 + voxelAxis]) / (columnLengths[voxelAxis] || 1),
      0
    )
    if (score > bestScore) {
      best = candidate
      bestScore = score
    }
  }
  return best
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
  plane: Pick<PlaneSpec, 'colAxis' | 'rowAxis'>
): SliceDirectionLabels {
  const worldAxes = worldAxesForVoxelAxes(affine)
  return {
    left: labelForVoxelDirection(affine, plane.colAxis, false, worldAxes),
    right: labelForVoxelDirection(affine, plane.colAxis, true, worldAxes),
    top: labelForVoxelDirection(affine, plane.rowAxis, true, worldAxes),
    bottom: labelForVoxelDirection(affine, plane.rowAxis, false, worldAxes)
  }
}
