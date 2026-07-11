import type { ModelAssetId } from './catalog'

export interface ModelAssetUrls {
  json: URL
  weights: URL
  colors: URL | null
}

const ASSET_URLS: Readonly<Record<ModelAssetId, ModelAssetUrls>> = {
  'hidden-light': {
    json: new URL('./assets/model.json', import.meta.url),
    weights: new URL('./assets/weights.bin', import.meta.url),
    colors: null
  },
  'tissue-3': {
    json: new URL('./assets/model20chan3cls/model.json', import.meta.url),
    weights: new URL('./assets/model20chan3cls/weights.bin', import.meta.url),
    colors: new URL('./assets/model20chan3cls/colormap.json?no-inline', import.meta.url)
  },
  'subcortical-18': {
    json: new URL('./assets/model30chan18cls/model.json', import.meta.url),
    weights: new URL('./assets/model30chan18cls/weights.bin', import.meta.url),
    colors: new URL('./assets/model30chan18cls/colormap.json?no-inline', import.meta.url)
  },
  'compact-18': {
    json: new URL('./assets/model18cls/model.json', import.meta.url),
    weights: new URL('./assets/model18cls/weights.bin', import.meta.url),
    colors: new URL('./assets/model18cls/colormap.json?no-inline', import.meta.url)
  },
  'aparc-50': {
    json: new URL('./assets/model30chan50cls/model.json', import.meta.url),
    weights: new URL('./assets/model30chan50cls/weights.bin', import.meta.url),
    colors: new URL('./assets/model30chan50cls/colormap.json?no-inline', import.meta.url)
  },
  'extract-3': {
    json: new URL('./assets/model11_gw_ae/model.json', import.meta.url),
    weights: new URL('./assets/model11_gw_ae/weights.bin', import.meta.url),
    colors: new URL('./assets/model11_gw_ae/colormap.json?no-inline', import.meta.url)
  },
  'aparc-104': {
    json: new URL('./assets/model21_104class/model.json', import.meta.url),
    weights: new URL('./assets/model21_104class/weights.bin', import.meta.url),
    colors: new URL('./assets/model21_104class/colormap.json?no-inline', import.meta.url)
  },
  'mindgrab-2': {
    json: new URL('./assets/mindgrab/model.json', import.meta.url),
    weights: new URL('./assets/mindgrab/weights.bin', import.meta.url),
    colors: new URL('./assets/mindgrab/colormap.json?no-inline', import.meta.url)
  }
}

export function modelAssetUrls(id: ModelAssetId): ModelAssetUrls {
  return ASSET_URLS[id]
}
