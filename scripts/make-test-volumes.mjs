// Generates synthetic .nii / .nii.gz volumes with closed-form voxel values
// so the viewer can be verified end-to-end without any real data.
// Usage: node scripts/make-test-volumes.mjs [outDir]
import { gzipSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const HEADER = 348
const DATA_START = 352

const DT = {
  uint8: { code: 2, bytes: 1, write: (dv, o, v, le) => dv.setUint8(o, v) },
  int16: { code: 4, bytes: 2, write: (dv, o, v, le) => dv.setInt16(o, v, le) },
  float32: { code: 16, bytes: 4, write: (dv, o, v, le) => dv.setFloat32(o, v, le) }
}

/**
 * Build a complete single-file volume buffer.
 * opts: { dims:[nx,ny,nz,(nt)], dtype, value(i,j,k,t), spacing:[sx,sy,sz],
 *         thirdAxisSign, rowTransform:{rows:3x4}|null, rotationTransform:{b,c,d,ox,oy,oz}|null,
 *         slope, inter, littleEndian, labels:[[index, name], ...] }
 * labels embeds an "index<TAB>name" text table between the header and the
 * data (intent code 1002, extension flag zero, data offset moved past it).
 */
export function buildVolume(opts) {
  const le = opts.littleEndian !== false
  const [nx, ny, nz] = opts.dims
  const nt = opts.dims[3] ?? 1
  const ndim = nt > 1 ? 4 : 3
  const dt = DT[opts.dtype]
  const n = nx * ny * nz * nt
  const table = opts.labels
    ? new TextEncoder().encode(opts.labels.map(([i, name]) => `${i}\t${name}`).join('\n'))
    : null
  const dataOffset = table
    ? Math.ceil((DATA_START + table.length) / 16) * 16 // keep voxel data aligned
    : DATA_START
  const buf = new ArrayBuffer(dataOffset + n * dt.bytes)
  const dv = new DataView(buf)

  dv.setInt32(0, HEADER, le)
  dv.setInt16(40, ndim, le)
  const dims = [nx, ny, nz, nt, 1, 1, 1]
  for (let i = 0; i < 7; i++) dv.setInt16(42 + i * 2, dims[i], le)
  dv.setInt16(70, dt.code, le)
  dv.setInt16(72, dt.bytes * 8, le)
  dv.setFloat32(76, opts.thirdAxisSign ?? 1, le)
  const spacing = opts.spacing ?? [1, 1, 1]
  for (let i = 0; i < 3; i++) dv.setFloat32(80 + i * 4, spacing[i], le)
  if (nt > 1) dv.setFloat32(92, 1, le)
  if (table) dv.setInt16(68, 1002, le)
  dv.setFloat32(108, dataOffset, le)
  dv.setFloat32(112, opts.slope ?? 0, le)
  dv.setFloat32(116, opts.inter ?? 0, le)

  if (opts.rotationTransform) {
    dv.setInt16(252, 1, le)
    dv.setFloat32(256, opts.rotationTransform.b, le)
    dv.setFloat32(260, opts.rotationTransform.c, le)
    dv.setFloat32(264, opts.rotationTransform.d, le)
    dv.setFloat32(268, opts.rotationTransform.ox, le)
    dv.setFloat32(272, opts.rotationTransform.oy, le)
    dv.setFloat32(276, opts.rotationTransform.oz, le)
  }
  if (opts.rowTransform) {
    dv.setInt16(254, 1, le)
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 4; c++) {
        dv.setFloat32(280 + r * 16 + c * 4, opts.rowTransform.rows[r][c], le)
      }
    }
  }

  dv.setUint8(344, 0x6e) // n
  dv.setUint8(345, 0x2b) // +
  dv.setUint8(346, 0x31) // 1
  dv.setUint8(347, 0)

  if (table) new Uint8Array(buf, DATA_START, table.length).set(table)

  let o = dataOffset
  for (let t = 0; t < nt; t++) {
    for (let k = 0; k < nz; k++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          dt.write(dv, o, opts.value(i, j, k, t), le)
          o += dt.bytes
        }
      }
    }
  }
  return Buffer.from(buf)
}

function identityRowTransform(ox, oy, oz) {
  return {
    rows: [
      [1, 0, 0, ox],
      [0, 1, 0, oy],
      [0, 0, 1, oz]
    ]
  }
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())
if (isMain) {
  const outDir = process.argv[2] ?? 'testdata'
  mkdirSync(outDir, { recursive: true })
  const save = (name, buf) => {
    writeFileSync(join(outDir, name), buf)
    console.log(`wrote ${join(outDir, name)} (${buf.length} bytes)`)
  }

  // 1. Ramp along axis 0, uint8, rowTransform identity + offset (10,20,30).
  save(
    'grad_u8.nii',
    buildVolume({
      dims: [64, 64, 40],
      dtype: 'uint8',
      value: (i) => (i * 4) % 256,
      rowTransform: identityRowTransform(10, 20, 30)
    })
  )

  // 2. Centered ball, int16, slope/inter scaling, anisotropic spacing,
  //    identity quaternion transform; marker voxel at (10,20,30) = raw 2000.
  save(
    'sphere_i16_scl.nii',
    buildVolume({
      dims: [64, 64, 40],
      dtype: 'int16',
      spacing: [1, 1, 2.5],
      slope: 0.5,
      inter: -25,
      rotationTransform: { b: 0, c: 0, d: 0, ox: -32, oy: -32, oz: -50 },
      value: (i, j, k) => {
        if (i === 10 && j === 20 && k === 30) return 2000
        const dx = i - 32
        const dy = j - 32
        const dz = (k - 20) * 2.5
        return dx * dx + dy * dy + dz * dz <= 15 * 15 ? 1000 : 100
      }
    })
  )

  // 3. 4D float ramp, gzipped: value = k + 100*t.
  save(
    'grad_f32_4d.nii.gz',
    gzipSync(
      buildVolume({
        dims: [32, 32, 20, 5],
        dtype: 'float32',
        value: (_i, _j, k, t) => k + 100 * t
      })
    )
  )

  // 4. Same ramp as #1 but written big-endian.
  save(
    'grad_i16_be.nii',
    buildVolume({
      dims: [64, 64, 40],
      dtype: 'int16',
      littleEndian: false,
      value: (i) => (i * 4) % 256,
      rowTransform: identityRowTransform(10, 20, 30)
    })
  )

  // 5. Negative thirdAxisSign: world z must decrease as k increases.
  save(
    'thirdAxisSign_neg.nii',
    buildVolume({
      dims: [16, 16, 16],
      dtype: 'uint8',
      thirdAxisSign: -1,
      rotationTransform: { b: 0, c: 0, d: 0, ox: 0, oy: 0, oz: 0 },
      value: (_i, _j, k) => k * 16
    })
  )

  // 6. Corrupt fixtures for error handling.
  const bad = buildVolume({ dims: [8, 8, 8], dtype: 'uint8', value: () => 0 })
  bad[344] = 0x78 // break the signature
  save('bad_magic.nii', bad)

  const ok = buildVolume({ dims: [8, 8, 8], dtype: 'uint8', value: () => 0 })
  save('truncated.nii', ok.subarray(0, DATA_START + 100))

  // 7. Overlay fixtures over grad_u8.nii (same world region, offset (10,20,30)).

  // Label volume on a 2x-coarser grid: blocks of ids 1..16 in the middle.
  save(
    'labels_coarse.nii',
    buildVolume({
      dims: [32, 32, 20],
      dtype: 'uint8',
      spacing: [2, 2, 2],
      rowTransform: {
        rows: [
          [2, 0, 0, 10],
          [0, 2, 0, 20],
          [0, 0, 2, 30]
        ]
      },
      value: (i, j, k) =>
        i >= 8 && i < 24 && j >= 8 && j < 24 && k >= 5 && k < 15
          ? ((i - 8) >> 2) + 4 * ((j - 8) >> 2) + 1
          : 0,
      labels: Array.from({ length: 16 }, (_, n) => [n + 1, `region-${n + 1}`])
    })
  )

  // Smooth signed value map for the diverging colormap, gzipped.
  save(
    'map_signed.nii.gz',
    gzipSync(
      buildVolume({
        dims: [64, 64, 40],
        dtype: 'float32',
        rowTransform: identityRowTransform(10, 20, 30),
        value: (i, j, k) => (i - 32) * Math.exp(-((j - 32) ** 2 + (k - 20) ** 2) / 200)
      })
    )
  )

  // Binary ball mask on the base grid.
  save(
    'mask_ball.nii',
    buildVolume({
      dims: [64, 64, 40],
      dtype: 'uint8',
      rowTransform: identityRowTransform(10, 20, 30),
      value: (i, j, k) => {
        const dx = i - 32
        const dy = j - 32
        const dz = k - 20
        return dx * dx + dy * dy + dz * dz <= 12 * 12 ? 1 : 0
      }
    })
  )
}
