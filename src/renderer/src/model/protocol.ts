import type { ModelBackend } from '../../../shared/settings'
import type { VoxelArray } from '../volume/types'
import type { ModelVariantId } from './catalog'

export const MODEL_TARGET_DIM = 256
export const MODEL_MAX_SOURCE_VOXELS = 32 * 1024 * 1024
export const MODEL_MAX_SOURCE_BYTES = 256 * 1024 * 1024

export type ModelErrorCode =
  | 'unsupported'
  | 'invalid-volume'
  | 'volume-too-large'
  | 'asset-failed'
  | 'asset-invalid'
  | 'prepare-failed'
  | 'run-failed'

export type ModelProgressStage = 'prepare' | 'load' | 'prerequisite' | 'infer' | 'writeback'

export interface ModelRunRequest {
  type: 'run'
  token: number
  volumeSession: number
  variantId: ModelVariantId
  /** Preferred execution backend; the worker falls back to the other. */
  backend: ModelBackend
  dims: [number, number, number]
  affine: Float64Array
  datatypeCode: number
  slope: number
  inter: number
  raw: VoxelArray
}

export type ModelWorkerRequest = ModelRunRequest

export type ModelWorkerResponse =
  | {
      type: 'progress'
      token: number
      volumeSession: number
      variantId: ModelVariantId
      progress: number
      stage: ModelProgressStage
      /** Backend that won the initialization chain; null before it settles. */
      backend: ModelBackend | null
    }
  | {
      type: 'complete'
      token: number
      volumeSession: number
      variantId: ModelVariantId
      labels: Uint8Array
      counts: Uint32Array
    }
  | {
      type: 'error'
      token: number
      volumeSession: number
      variantId: ModelVariantId
      code: ModelErrorCode
    }

export function modelErrorMessage(code: ModelErrorCode): string {
  switch (code) {
    case 'unsupported':
      return 'Model execution is not supported by this graphics device.'
    case 'invalid-volume':
      return 'This volume cannot be prepared for model execution.'
    case 'volume-too-large':
      return 'This volume is too large for the built-in model.'
    case 'asset-failed':
      return 'The built-in model could not be read.'
    case 'asset-invalid':
      return 'The built-in model failed its integrity check.'
    case 'prepare-failed':
      return 'The volume could not be prepared for model execution.'
    case 'run-failed':
      return 'Model execution failed.'
  }
}
