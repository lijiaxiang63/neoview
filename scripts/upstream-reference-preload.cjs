const { contextBridge } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const { isAbsolute } = require('node:path')

function allowed(path, write) {
  return (
    typeof path === 'string' &&
    isAbsolute(path) &&
    (write ? path.endsWith('.nii.gz') : path.endsWith('.nii') || path.endsWith('.nii.gz'))
  )
}

contextBridge.exposeInMainWorld('referenceFiles', {
  read(path) {
    if (!allowed(path, false)) throw new Error('Reference input path is invalid.')
    const bytes = readFileSync(path)
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  },
  write(path, value) {
    if (!allowed(path, true) || !(value instanceof ArrayBuffer)) {
      throw new Error('Reference output is invalid.')
    }
    writeFileSync(path, new Uint8Array(value))
  }
})
