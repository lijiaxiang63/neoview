import type { NeoviewApi } from './index'

declare global {
  interface Window {
    neoview: NeoviewApi
  }
}

export {}
