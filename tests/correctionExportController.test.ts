import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAppStore, type AppStore } from '../src/renderer/src/store'
import { CorrectionExportController } from '../src/renderer/src/runtime/correctionExportController'
import { defaultCorrectionConfig } from '../src/renderer/src/stats/correctionConfig'
import { buildThresholdedMap } from '../src/renderer/src/stats/correctionExport'
import type { SignificanceResult } from '../src/renderer/src/stats/correctionConfig'
import type { Volume } from '../src/renderer/src/volume/types'

let store: AppStore

function volume(): Volume {
  return {
    name: 'map.nii',
    dims: [1, 1, 1],
    frames: 1,
    spacing: [1, 1, 1],
    affine: new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    datatypeCode: 16,
    datatypeName: 'float32',
    raw: new Float32Array([5]),
    slope: 1,
    inter: 0,
    transformSource: 'rows',
    suggestedRange: null,
    labels: null,
    statistic: { kind: 'z', dof1: null, dof2: null },
    smoothness: null,
    stats: { dataMin: 5, dataMax: 5, p2: 5, p98: 5, typeRange: null }
  }
}

beforeEach(() => {
  store = createAppStore({ storage: null, pagehideTarget: null })
})

afterEach(() => store.dispose())

describe('CorrectionExportController', () => {
  it('does not export invalid probability values', () => {
    const source = volume()
    source.raw[0] = -0.01
    const significance: SignificanceResult = {
      statThreshold: 0.05,
      minClusterSize: null,
      mask: null,
      kind: 'p',
      tail: 'one',
      survivingVoxels: 0,
      smoothness: null,
      report: null,
      membership: null,
      configRev: 1,
      frame: 0,
      stale: false
    }

    expect(buildThresholdedMap(source, significance, 0)[0]).toBe(0)
  })

  it('rejects a stale result instead of writing it', async () => {
    const exportFile = vi.fn()
    const controller = new CorrectionExportController({
      store,
      bridge: { exportFile },
      storage: { getItem: () => '/out', setItem: vi.fn() }
    })
    store.getState().setVolume(volume(), '/source/base.nii')
    store.getState().addOverlay(volume(), '/source/map.nii')
    const layer = store.getState().overlays[0]
    const correction = defaultCorrectionConfig(layer.volume.statistic)
    store.setState({
      overlays: [
        {
          ...layer,
          correction,
          significance: {
            statThreshold: 1.96,
            minClusterSize: null,
            mask: null,
            kind: 'z',
            tail: 'two',
            survivingVoxels: 1,
            smoothness: null,
            report: null,
            membership: null,
            configRev: correction.rev,
            frame: 0,
            stale: true
          }
        }
      ]
    })

    await expect(controller.export(layer)).resolves.toBe(true)
    expect(exportFile).not.toHaveBeenCalled()
    expect(store.getState().errorMessage).toContain('finish')
    controller.dispose()
  })
})
