// Temporary local benchmark — measures each loading stage on a real file.
// Run: REAL_FILE=<path> npx vitest run tests/perf.local.test.ts --disable-console-intercept
import { readFileSync } from 'node:fs'
import { describe, it } from 'vitest'
import { parseVolume } from '../src/renderer/src/volume/parse'
import { buildTexData, planTexture } from '../src/renderer/src/render3d/normalize'
import { gunzip } from '../src/renderer/src/volume/gunzip'

const FILE = process.env.REAL_FILE

describe.skipIf(!FILE)('load pipeline timing', () => {
  it('times each stage', { timeout: 120000 }, async () => {
    const fileBuf = readFileSync(FILE as string)
    const gzBytes = fileBuf.buffer.slice(
      fileBuf.byteOffset,
      fileBuf.byteOffset + fileBuf.byteLength
    ) as ArrayBuffer

    const t0 = performance.now()
    const inflated = await gunzip(gzBytes)
    const tGunzip = performance.now()

    const vol = parseVolume('real.nii', inflated)
    const tParse = performance.now()

    const plan = planTexture(vol.dims, vol.spacing)
    const tex = buildTexData(vol, 0, plan)
    const tTex = performance.now()

    console.log(`
inflated size:       ${(inflated.byteLength / 1e6).toFixed(1)} MB
dims:                ${vol.dims.join(' x ')} dtype=${vol.datatypeName}
tex dims:            ${plan.texDims.join(' x ')} (stride ${plan.stride.join('/')}) -> ${(tex.byteLength / 1e6).toFixed(0)} MB half-float

gunzip (prealloc):   ${(tGunzip - t0).toFixed(0)} ms   [worker]
parse + stats:       ${(tParse - tGunzip).toFixed(0)} ms   [worker]
buildTexData:        ${(tTex - tParse).toFixed(0)} ms   [worker]
worker total:        ${(tTex - t0).toFixed(0)} ms
main thread pays:    GPU upload of ${(tex.byteLength / 1e6).toFixed(0)} MB only
`)
  })
})
