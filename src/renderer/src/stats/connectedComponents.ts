// 3D connected-component labelling over a binary mask, 6- or 26-connectivity,
// iterative (no recursion) so whole-volume masks never overflow the stack. Pure.

export type Connectivity = 6 | 26

export interface Components {
  /** Cluster id per voxel: 0 = background, 1..count otherwise. */
  labels: Int32Array
  /** Voxel count per cluster; sizes[id-1] is the size of cluster id. */
  sizes: Int32Array
  count: number
}

function neighborDeltas(connectivity: Connectivity): [number, number, number][] {
  const deltas: [number, number, number][] = []
  for (let dk = -1; dk <= 1; dk++) {
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (di === 0 && dj === 0 && dk === 0) continue
        const manhattan = Math.abs(di) + Math.abs(dj) + Math.abs(dk)
        if (connectivity === 6 && manhattan > 1) continue
        deltas.push([di, dj, dk])
      }
    }
  }
  return deltas
}

/** Label the connected components of `mask` on the `dims` grid. */
export function labelClusters(
  mask: Uint8Array,
  dims: [number, number, number],
  connectivity: Connectivity
): Components {
  const [nx, ny, nz] = dims
  const sy = nx
  const sz = nx * ny
  const n = nx * ny * nz
  const labels = new Int32Array(n)
  const sizes: number[] = []
  const deltas = neighborDeltas(connectivity)
  const stack = new Int32Array(n)
  let count = 0

  for (let seed = 0; seed < n; seed++) {
    if (!mask[seed] || labels[seed] !== 0) continue
    const label = ++count
    labels[seed] = label
    let top = 0
    stack[top++] = seed
    let size = 0
    while (top > 0) {
      const idx = stack[--top]
      size++
      const k = (idx / sz) | 0
      const rem = idx - k * sz
      const j = (rem / nx) | 0
      const i = rem - j * nx
      for (let d = 0; d < deltas.length; d++) {
        const ni = i + deltas[d][0]
        if (ni < 0 || ni >= nx) continue
        const nj = j + deltas[d][1]
        if (nj < 0 || nj >= ny) continue
        const nk = k + deltas[d][2]
        if (nk < 0 || nk >= nz) continue
        const nIdx = ni + nj * sy + nk * sz
        if (mask[nIdx] && labels[nIdx] === 0) {
          labels[nIdx] = label
          stack[top++] = nIdx
        }
      }
    }
    sizes.push(size)
  }

  return { labels, sizes: Int32Array.from(sizes), count }
}
