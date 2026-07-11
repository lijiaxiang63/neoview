import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  MODEL_AUTOMATION_VARIANTS,
  modelReferenceSampleKey,
  parseModelAutomationArgs
} from './run-model-reference.mjs'

const execFileAsync = promisify(execFile)
const REQUIRED_REVISION = '4c87885f3a2a8835e260d521dcec922b58d91d41'
const DEFAULT_SOURCE = '/tmp/neoview-brainchop-reference'
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(SCRIPT_DIR, '..')
const ELECTRON_APP = join(
  ROOT,
  'node_modules',
  'electron',
  'dist',
  'Electron.app'
)
const ELECTRON_ENTRY = resolve(SCRIPT_DIR, 'upstream-reference-electron.cjs')
const ELECTRON_PRELOAD = resolve(SCRIPT_DIR, 'upstream-reference-preload.cjs')
const REFERENCE_APP = join(homedir(), 'Applications', 'NeoviewReference.app')
const REFERENCE_BUNDLE_ID = 'com.neoview.reference'
const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'

const upstreamIndex = new Map([
  ['tissue-high', 1],
  ['tissue-low', 2],
  ['subcortical-high', 3],
  ['subcortical-low', 4],
  ['subcortical-compact', 5],
  ['subcortical-failsafe', 6],
  ['aparc-50-high', 7],
  ['aparc-50-low', 8],
  ['extract-high', 10],
  ['mask-high', 12],
  ['aparc-104-high', 13],
  ['aparc-104-low', 14],
  ['mindgrab-high', 15],
  ['mindgrab-low', 16]
])
const mainThreadVariants = new Set([
  'subcortical-failsafe',
  'aparc-50-high',
  'aparc-50-low',
  'aparc-104-high'
])
export function parseUpstreamAutomationArgs(argv) {
  let source = DEFAULT_SOURCE
  const forwarded = []
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--source') {
      const value = argv[++index]
      if (!value) throw new Error('--source requires a directory.')
      source = resolve(value)
    } else {
      forwarded.push(argv[index])
    }
  }
  return { ...parseModelAutomationArgs(forwarded), source }
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function freePort() {
  return await new Promise((resolvePort, rejectPort) => {
    const reservation = createServer()
    reservation.once('error', rejectPort)
    reservation.listen(0, '127.0.0.1', () => {
      const address = reservation.address()
      const port = typeof address === 'object' && address ? address.port : null
      reservation.close((error) => {
        if (error || !port) rejectPort(error ?? new Error('Could not reserve a local port.'))
        else resolvePort(port)
      })
    })
  })
}

async function waitForServer(server, serverUrl) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error('The fixed upstream server exited early.')
    try {
      const response = await fetch(`${serverUrl}main.js`)
      if (response.ok && (await response.text()).includes('window.__modelReferenceDialog')) return
    } catch {
      // The development server has not bound its port yet.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
  }
  throw new Error('The upstream development server did not start.')
}

async function verifySource(source) {
  const result = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: source,
    maxBuffer: 1024 * 1024
  })
  if (result.stdout.trim() !== REQUIRED_REVISION) {
    throw new Error(`Upstream source must be at ${REQUIRED_REVISION}.`)
  }
  for (const args of [
    ['diff', '--quiet'],
    ['diff', '--cached', '--quiet']
  ]) {
    try {
      await execFileAsync('git', args, { cwd: source, maxBuffer: 1024 * 1024 })
    } catch {
      throw new Error('The fixed upstream source has tracked modifications.')
    }
  }
  await access(join(source, 'node_modules', '@tensorflow', 'tfjs'))
  await access(ELECTRON_APP)
  await access(ELECTRON_ENTRY)
  await access(ELECTRON_PRELOAD)
}

async function command(file, args, options = {}) {
  const result = await execFileAsync(file, args, {
    cwd: ROOT,
    maxBuffer: 16 * 1024 * 1024,
    ...options
  })
  return result.stdout.trim()
}

async function cua(tool, payload) {
  return command('cua-driver', [tool, JSON.stringify(payload)])
}

class CdpPage {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      if (!message.id) return
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    })
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error('The fixed reference page closed.'))
      }
      this.pending.clear()
    })
  }

  static async connect(debuggingPort) {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      try {
        const targets = await (
          await fetch(`http://127.0.0.1:${debuggingPort}/json/list`)
        ).json()
        const target = targets.find((item) => item.type === 'page')
        if (target?.webSocketDebuggerUrl) {
          const socket = new WebSocket(target.webSocketDebuggerUrl)
          await new Promise((resolveOpen, rejectOpen) => {
            socket.addEventListener('open', resolveOpen, { once: true })
            socket.addEventListener('error', rejectOpen, { once: true })
          })
          return new CdpPage(socket)
        }
      } catch {
        // The matching runtime has not exposed its page target yet.
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
    }
    throw new Error('Could not connect to the matching reference page.')
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolveMessage, rejectMessage) => {
      this.pending.set(id, { resolve: resolveMessage, reject: rejectMessage })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(javascript) {
    const response = await this.send('Runtime.evaluate', {
      expression: javascript,
      awaitPromise: true,
      returnByValue: true
    })
    if (response.exceptionDetails) {
      const description = response.exceptionDetails.exception?.description
      throw new Error(description ?? response.exceptionDetails.text ?? 'Reference evaluation failed.')
    }
    return response.result?.value ?? null
  }

  close() {
    this.socket.close()
  }
}

async function snapshot(session) {
  return JSON.parse(
    await cua('get_window_state', { pid: session.pid, window_id: session.windowId })
  )
}

async function evaluate(session, javascript) {
  return session.page.evaluate(javascript)
}

async function act(session, javascript) {
  await snapshot(session)
  const result = await evaluate(session, javascript)
  await snapshot(session)
  return result
}

async function prepareReferenceApp(serverPort, debuggingPort) {
  if (await referenceAppRunning()) {
    throw new Error('Close the existing NeoviewReference instance before running automation.')
  }
  await mkdir(dirname(REFERENCE_APP), { recursive: true })
  await rm(REFERENCE_APP, { recursive: true, force: true })
  await command('cp', ['-R', '-c', ELECTRON_APP, REFERENCE_APP])
  const runtime = await mkdtemp(join(tmpdir(), 'neoview-reference-runtime-'))
  try {
    const mainSource = (await readFile(ELECTRON_ENTRY, 'utf8'))
      .replace('__REFERENCE_SERVER_PORT__', String(serverPort))
      .replace('__REFERENCE_DEBUG_PORT__', String(debuggingPort))
    await writeFile(join(runtime, 'main.cjs'), mainSource)
    await writeFile(join(runtime, 'preload.cjs'), await readFile(ELECTRON_PRELOAD))
    await writeFile(
      join(runtime, 'package.json'),
      `${JSON.stringify(
        {
          name: 'neoview-reference-runtime',
          version: '1.0.0',
          main: 'main.cjs'
        },
        null,
        2
      )}\n`
    )
    await command(join(ROOT, 'node_modules', '.bin', 'asar'), [
      'pack',
      runtime,
      join(REFERENCE_APP, 'Contents', 'Resources', 'app.asar')
    ])
    const plist = join(REFERENCE_APP, 'Contents', 'Info.plist')
    await command('plutil', ['-replace', 'CFBundleIdentifier', '-string', REFERENCE_BUNDLE_ID, plist])
    await command('plutil', ['-replace', 'CFBundleName', '-string', 'NeoviewReference', plist])
    await command('plutil', [
      '-replace',
      'CFBundleDisplayName',
      '-string',
      'NeoviewReference',
      plist
    ])
    await command('codesign', ['--force', '--deep', '--sign', '-', REFERENCE_APP])
    await command(LSREGISTER, ['-f', REFERENCE_APP])
  } finally {
    await rm(runtime, { recursive: true, force: true })
  }
}

async function patchUpstreamRuntime(source) {
  const path = join(source, 'main.js')
  const original = await readFile(path, 'utf8')
  const runtimeNeedle = 'const nv1 = new Niivue(defaults);'
  const mainNeedle = 'async function main() {'
  if (!original.includes(runtimeNeedle) || !original.includes(mainNeedle)) {
    throw new Error('Could not expose the fixed upstream runtime.')
  }
  let patched = original.replace(
    mainNeedle,
    `brainChopOpts.isPostProcessEnable = false;\n${mainNeedle}`
  )
  patched = patched.replace(
    runtimeNeedle,
    `${runtimeNeedle}\n  window.__modelReferenceDialog = null;\n  window.alert = (message) => { window.__modelReferenceDialog = String(message); };\n  window.__modelReference = { nv1, workerRunning: () => typeof chopWorker !== "undefined" };`
  )
  await writeFile(path, patched)
  return async () => writeFile(path, original)
}

async function launchReferenceApp(debuggingPort) {
  const launched = JSON.parse(
    await cua('launch_app', {
      bundle_id: REFERENCE_BUNDLE_ID,
      electron_debugging_port: debuggingPort
    })
  )
  const window = launched.windows.find((item) => item.title) ?? launched.windows[0]
  if (!window) throw new Error('The matching Electron runtime did not create a window.')
  const session = { pid: launched.pid, windowId: window.window_id, page: null }
  try {
    session.page = await CdpPage.connect(debuggingPort)
    await snapshot(session)
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const ready = await evaluate(
        session,
        `Boolean(window.__modelReference?.nv1?.volumes?.length === 1)`
      ).catch(() => false)
      if (ready) return session
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
    }
    throw new Error('The fixed upstream runtime did not initialize.')
  } catch (error) {
    await stopReferenceSession(session)
    throw error
  }
}

async function waitForReferenceExit() {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (!(await referenceAppRunning())) return
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  throw new Error('The matching reference runtime did not exit.')
}

async function referenceAppRunning() {
  const state = JSON.parse(await cua('list_apps', {}))
  return state.apps.some((item) => item.bundle_id === REFERENCE_BUNDLE_ID && item.running)
}

async function stopServer(server) {
  if (server.exitCode !== null || server.signalCode !== null) return
  server.kill('SIGTERM')
  const exited = await Promise.race([
    once(server, 'exit').then(() => true),
    new Promise((resolveDelay) => setTimeout(() => resolveDelay(false), 5_000))
  ])
  if (!exited && server.exitCode === null && server.signalCode === null) {
    server.kill('SIGKILL')
    if (server.exitCode === null && server.signalCode === null) await once(server, 'exit')
  }
}

async function stopReferenceSession(session) {
  if (await referenceAppRunning()) {
    await snapshot(session)
    await cua('hotkey', { pid: session.pid, keys: ['cmd', 'q'] })
    await waitForReferenceExit()
  }
  session.page?.close()
}

async function loadInput(session, inputPath) {
  return act(
    session,
    `(async () => {
      const runtime = window.__modelReference
      while (runtime.nv1.volumes.length > 0) {
        await runtime.nv1.removeVolume(runtime.nv1.volumes[0])
      }
      if (window.__modelReferenceInputUrl) URL.revokeObjectURL(window.__modelReferenceInputUrl)
      const bytes = await window.referenceFiles.read(${JSON.stringify(inputPath)})
      const blob = new Blob([new Uint8Array(bytes)])
      const url = URL.createObjectURL(blob)
      window.__modelReferenceInputUrl = url
      await runtime.nv1.loadVolumes([{ url, name: ${JSON.stringify(basename(inputPath))} }])
      const volume = runtime.nv1.volumes[0]
      let actualMin = Infinity
      let actualMax = -Infinity
      let nonFinite = 0
      for (const value of volume.img) {
        if (!Number.isFinite(value)) { nonFinite++; continue }
        actualMin = Math.min(actualMin, value)
        actualMax = Math.max(actualMax, value)
      }
      const transform = runtime.nv1.conformVox2Vox(
        volume.hdr.dims,
        volume.hdr.affine.flat(),
        256,
        1,
        false
      )
      return {
        dims: volume.hdr.dims,
        affine: volume.hdr.affine.flat(),
        inputMin: volume.global_min,
        inputMax: volume.global_max,
        actualMin,
        actualMax,
        nonFinite,
        storedType: volume.img.constructor.name,
        headerRange: [volume.hdr.cal_min, volume.hdr.cal_max],
        scale: runtime.nv1.getScale(volume, 0, 255, 0, 0.999),
        targetAffine: Array.from(transform[0]),
        targetToSource: Array.from(transform[2])
      }
    })()`
  )
}

async function saveVolume(session, volumeIndex, targetPath) {
  await mkdir(dirname(targetPath), { recursive: true })
  const stagedPath = join(
    dirname(targetPath),
    `.${basename(targetPath)}.incoming-${process.pid}-${Date.now()}.nii.gz`
  )
  try {
    await act(
      session,
      `(async () => {
      const target = ${JSON.stringify(stagedPath)}
      const volume = window.__modelReference.nv1.volumes[${volumeIndex}]
      if (!volume) throw new Error('Reference volume is unavailable.')
      await new Promise((resolve, reject) => {
        const original = HTMLAnchorElement.prototype.click
        const timer = setTimeout(() => { HTMLAnchorElement.prototype.click = original; reject(new Error('Reference save timed out.')) }, 60000)
        HTMLAnchorElement.prototype.click = function () {
          fetch(this.href)
            .then((response) => response.arrayBuffer())
            .then((buffer) => window.referenceFiles.write(target, buffer))
            .then(resolve, reject)
            .finally(() => { clearTimeout(timer); HTMLAnchorElement.prototype.click = original })
        }
        volume.saveToDisk('model-reference.nii.gz')
      })
      return true
    })()`
    )
    await rename(stagedPath, targetPath)
  } finally {
    await rm(stagedPath, { force: true })
  }
}

async function runVariant(session, variantId, targetPath) {
  const index = upstreamIndex.get(variantId)
  if (index === undefined) throw new Error(`No upstream model index for ${variantId}.`)
  await act(
    session,
    `(() => {
      window.__modelReferenceDialog = null
      document.querySelector('#workerCheck').checked = ${!mainThreadVariants.has(variantId)}
      const select = document.querySelector('#modelSelect')
      select.selectedIndex = ${index}
      select.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`
  )
  const deadline = Date.now() + 20 * 60_000
  while (Date.now() < deadline) {
    const state = await evaluate(
      session,
      `({
        dialog: window.__modelReferenceDialog,
        ready: Boolean(window.__modelReference && !window.__modelReference.workerRunning() && window.__modelReference.nv1.volumes.length > 1)
      })`
    )
    if (state.dialog) throw new Error(`${variantId}: ${state.dialog}`)
    if (state.ready) {
      await saveVolume(session, 1, targetPath)
      return
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500))
  }
  throw new Error(`${variantId}: fixed upstream execution timed out.`)
}

async function main() {
  const options = parseUpstreamAutomationArgs(process.argv.slice(2))
  await verifySource(options.source)
  const serverPort = await freePort()
  let debuggingPort = await freePort()
  while (debuggingPort === serverPort) debuggingPort = await freePort()
  const serverUrl = `http://127.0.0.1:${serverPort}/`
  let restoreRuntime = null
  let server = null
  let serverError = ''
  let session = null
  try {
    await prepareReferenceApp(serverPort, debuggingPort)
    restoreRuntime = await patchUpstreamRuntime(options.source)
    server = spawn(
      'npm',
      ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(serverPort)],
      {
        cwd: options.source,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    server.stderr.on('data', (chunk) => {
      serverError += chunk.toString()
    })
    console.log('Starting fixed upstream server...')
    await waitForServer(server, serverUrl)
    console.log('Starting matching Electron runtime...')
    session = await launchReferenceApp(debuggingPort)
    for (let index = 0; index < options.jobs.length; index++) {
      const job = options.jobs[index]
      const target = join(
        options.output,
        'upstream',
        modelReferenceSampleKey(job.inputPath),
        `${job.variant.id}.nii.gz`
      )
      const gridTarget = join(
        options.output,
        'upstream-grid',
        `${modelReferenceSampleKey(job.inputPath)}.nii.gz`
      )
      console.log(
        `[${index + 1}/${options.jobs.length}] ${modelReferenceSampleKey(job.inputPath)} · ${job.variant.id}`
      )
      const gridMetadataPath = gridTarget.replace(/\.nii\.gz$/, '.json')
      if (!options.force) {
        const existing = await Promise.all(
          [target, gridTarget, gridMetadataPath].map((path) => exists(path))
        )
        if (existing.some(Boolean)) {
          throw new Error(`Reference output already exists: ${target}. Pass --force to replace it.`)
        }
      }
      const gridMetadata = await loadInput(session, job.inputPath)
      await runVariant(session, job.variant.id, target)
      if (options.force || !(await exists(gridTarget))) {
        await saveVolume(session, 0, gridTarget)
        await writeFile(
          gridMetadataPath,
          `${JSON.stringify(gridMetadata, null, 2)}\n`
        )
      }
    }
  } finally {
    try {
      if (session) await stopReferenceSession(session)
    } finally {
      try {
        if (server) await stopServer(server)
      } finally {
        try {
          if (restoreRuntime) await restoreRuntime()
        } finally {
          if (!(await referenceAppRunning())) {
            await command(LSREGISTER, ['-u', REFERENCE_APP]).catch(() => undefined)
            await rm(REFERENCE_APP, { recursive: true, force: true })
          }
        }
      }
    }
  }
  if (server?.exitCode && server.exitCode !== 0) throw new Error(serverError.trim())
  console.log(`Wrote ${options.jobs.length} upstream result(s).`)
}

if (MODEL_AUTOMATION_VARIANTS.length !== upstreamIndex.size) {
  throw new Error('The upstream model map is incomplete.')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
