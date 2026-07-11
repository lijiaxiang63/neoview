/// <reference lib="webworker" />

import {
  buildLabelMapExport,
  buildMaskExport,
  type ExportFormat,
  type ExportPayload,
  type ExportVolume
} from './exportRegions'
import type { Region } from './regions'

export interface ExportWorkerRequest {
  token: number
  kind: 'labels' | 'mask'
  volume: ExportVolume
  labelMap: Uint16Array
  regions: Region[]
  format: ExportFormat
}

export type ExportWorkerResponse =
  | { token: number; ok: true; payload: ExportPayload }
  | { token: number; ok: false; message: string }

self.onmessage = (event: MessageEvent<ExportWorkerRequest>): void => {
  const request = event.data
  void (
    request.kind === 'labels'
      ? buildLabelMapExport(request.volume, request.labelMap, request.regions, request.format)
      : buildMaskExport(
          request.volume,
          request.labelMap,
          request.regions.filter((region) => region.visible),
          request.format
        )
  ).then(
    (payload) => {
      const response: ExportWorkerResponse = { token: request.token, ok: true, payload }
      self.postMessage(response, { transfer: [payload.bytes] })
    },
    (error: unknown) => {
      const response: ExportWorkerResponse = {
        token: request.token,
        ok: false,
        message: error instanceof Error ? error.message : 'Export failed.'
      }
      self.postMessage(response)
    }
  )
}
