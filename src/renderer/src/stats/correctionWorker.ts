// Correction worker: a fresh module worker per run that resolves one
// CorrectionRequest off the UI thread and closes. Heavy work (FDR sort,
// smoothness, connected components, report) runs here so large volumes never
// block the renderer.

import { computeCorrection } from './correctionCore'
import type { CorrectionWorkerRequest, CorrectionWorkerResponse } from './correctionProtocol'

const post = (message: CorrectionWorkerResponse, transfer?: Transferable[]): void => {
  self.postMessage(message, transfer ?? [])
}

function run(request: CorrectionWorkerRequest): void {
  const { token, volumeSession, layerId } = request
  try {
    const result = computeCorrection(request, (stage, progress) =>
      post({ type: 'progress', token, volumeSession, layerId, stage, progress })
    )
    const transfer: Transferable[] = []
    if (result.mask) transfer.push(result.mask.buffer)
    if (result.membership) {
      transfer.push(result.membership.voxels.buffer, result.membership.offsets.buffer)
    }
    post({ type: 'complete', token, volumeSession, layerId, result }, transfer)
  } catch (error) {
    post({
      type: 'error',
      token,
      volumeSession,
      layerId,
      message: error instanceof Error ? error.message : 'Correction failed.'
    })
  }
}

self.onmessage = (event: MessageEvent<CorrectionWorkerRequest>): void => {
  run(event.data)
  self.close()
}
