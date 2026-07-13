// Wire contract for the correction worker. The request carries a full
// CorrectionRequest (single-frame values + config) plus run-scoping ids; the
// response returns the CorrectionResult or an error, scoped by the same ids.

import type { CorrectionRequest, CorrectionResult } from './correctionCore'

export type CorrectionProgressStage = 'scan' | 'smoothness' | 'clusters' | 'report'

export interface CorrectionWorkerRequest extends CorrectionRequest {
  type: 'run'
  token: number
  volumeSession: number
  layerId: number
}

export type CorrectionWorkerResponse =
  | {
      type: 'progress'
      token: number
      volumeSession: number
      layerId: number
      stage: CorrectionProgressStage
      progress: number
    }
  | {
      type: 'complete'
      token: number
      volumeSession: number
      layerId: number
      result: CorrectionResult
    }
  | {
      type: 'error'
      token: number
      volumeSession: number
      layerId: number
      message: string
    }
