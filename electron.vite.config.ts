import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { ISOLATION_HEADERS } from './src/main/rendererProtocol'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    server: { headers: ISOLATION_HEADERS },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()]
  }
})
