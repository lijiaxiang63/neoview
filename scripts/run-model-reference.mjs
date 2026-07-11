import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  access,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const APP_PATH = join(ROOT, 'dist', 'mac-arm64', 'Neoview.app')
const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
const BUNDLE_ID = 'com.neoview.app'
const DEFAULT_VARIANT = 'tissue-high'
const POLL_MS = 1_000

export const MODEL_AUTOMATION_VARIANTS = Object.freeze([
  { id: 'tissue-high', groupId: 'tissue-gwm' },
  { id: 'tissue-low', groupId: 'tissue-gwm' },
  { id: 'subcortical-high', groupId: 'subcortical-gwm' },
  { id: 'subcortical-low', groupId: 'subcortical-gwm' },
  { id: 'subcortical-failsafe', groupId: 'subcortical-gwm' },
  { id: 'subcortical-compact', groupId: 'subcortical-fast' },
  { id: 'aparc-50-high', groupId: 'aparc-50' },
  { id: 'aparc-50-low', groupId: 'aparc-50' },
  { id: 'extract-high', groupId: 'extract-mask' },
  { id: 'mask-high', groupId: 'extract-mask' },
  { id: 'aparc-104-high', groupId: 'aparc-104' },
  { id: 'aparc-104-low', groupId: 'aparc-104' },
  { id: 'mindgrab-high', groupId: 'mindgrab' },
  { id: 'mindgrab-low', groupId: 'mindgrab' }
])

function usage() {
  throw new Error(
    'Usage: npm run model:reference -- --output <dir> (--all <volume> | --default <volume> | --variant <id> <volume>)... [--force]'
  )
}

export function parseModelAutomationArgs(argv) {
  const jobs = []
  let output = null
  let force = false
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--force') {
      force = true
      continue
    }
    if (arg === '--variant') {
      const id = argv[++index]
      const inputPath = argv[++index]
      if (!id || !inputPath) usage()
      const variant = MODEL_AUTOMATION_VARIANTS.find((item) => item.id === id)
      if (!variant) usage()
      jobs.push({ inputPath: resolve(inputPath), variant })
      continue
    }
    const value = argv[++index]
    if (!value) usage()
    if (arg === '--output') output = resolve(value)
    else if (arg === '--all') {
      for (const variant of MODEL_AUTOMATION_VARIANTS) {
        jobs.push({ inputPath: resolve(value), variant })
      }
    } else if (arg === '--default') {
      jobs.push({
        inputPath: resolve(value),
        variant: MODEL_AUTOMATION_VARIANTS.find((item) => item.id === DEFAULT_VARIANT)
      })
    } else usage()
  }
  if (!output || jobs.length === 0 || jobs.some((job) => !job.variant)) usage()
  return { output, force, jobs }
}

function stripVolumeExtension(name) {
  if (name.endsWith('.nii.gz')) return name.slice(0, -7)
  return name.slice(0, -extname(name).length)
}

export function modelReferenceSampleKey(path) {
  const name = stripVolumeExtension(basename(path)).replace(/[^a-zA-Z0-9._-]+/g, '_')
  const identity = createHash('sha256').update(resolve(path)).digest('hex').slice(0, 12)
  return `${name}-${identity}`
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
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

async function snapshot(session) {
  return JSON.parse(
    await cua('get_window_state', { pid: session.pid, window_id: session.windowId })
  )
}

function parsePageResult(output) {
  const match = output.match(/```\s*([\s\S]*?)\s*```/)
  if (!match) throw new Error(`Unexpected page response: ${output}`)
  return JSON.parse(match[1])
}

async function evaluate(session, javascript) {
  return parsePageResult(
    await cua('page', {
      pid: session.pid,
      window_id: session.windowId,
      action: 'execute_javascript',
      javascript
    })
  )
}

async function act(session, javascript) {
  await snapshot(session)
  const result = await evaluate(session, javascript)
  await snapshot(session)
  return result
}

async function pageState(session) {
  return evaluate(
    session,
    `(() => ({
      title: document.title,
      text: document.body.innerText,
      buttons: [...document.querySelectorAll('button')].map((button) => ({
        text: button.innerText.trim(), disabled: button.disabled
      })),
      group: document.querySelector('#model-group')?.value ?? null,
      mode: document.querySelector('#model-mode')?.value ?? null
    }))()`
  )
}

async function waitFor(session, predicate, description, timeoutMs = 20 * 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await pageState(session)
    if (predicate(state)) return state
    await new Promise((resolveDelay) => setTimeout(resolveDelay, POLL_MS))
  }
  throw new Error(`Timed out waiting for ${description}.`)
}

async function launch() {
  const appState = JSON.parse(await cua('list_apps', {}))
  if (appState.apps.some((item) => item.bundle_id === BUNDLE_ID && item.running)) {
    throw new Error('Close the existing Neoview instance before running reference automation.')
  }
  await command(LSREGISTER, ['-f', APP_PATH])
  const launched = JSON.parse(
    await cua('launch_app', { bundle_id: BUNDLE_ID, electron_debugging_port: 9222 })
  )
  const window = launched.windows.find((item) => item.title) ?? launched.windows[0]
  if (!window) throw new Error('Neoview did not create a window.')
  const session = { pid: launched.pid, windowId: window.window_id }
  await snapshot(session)
  await pageState(session)
  return session
}

async function stop(session) {
  const initial = JSON.parse(await cua('list_apps', {}))
  if (!initial.apps.some((item) => item.bundle_id === BUNDLE_ID && item.running)) return
  await snapshot(session)
  await cua('hotkey', { pid: session.pid, keys: ['cmd', 'q'] })
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const state = JSON.parse(await cua('list_apps', {}))
    const app = state.apps.find((item) => item.bundle_id === BUNDLE_ID)
    if (!app?.running) return
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  throw new Error('Neoview did not exit after reference automation.')
}

async function loadInput(session, inputPath) {
  await snapshot(session)
  const launched = JSON.parse(await cua('launch_app', { bundle_id: BUNDLE_ID, urls: [inputPath] }))
  const window = launched.windows.find((item) => item.title?.includes(basename(inputPath)))
  if (window) session.windowId = window.window_id
  await snapshot(session)
  await waitFor(
    session,
    (state) =>
      state.title.includes(basename(inputPath)) && state.buttons.some((b) => b.text === 'REGIONS'),
    `input ${basename(inputPath)}`,
    60_000
  )
}

async function clickButton(session, text) {
  const clicked = await act(
    session,
    `(() => {
      const button = [...document.querySelectorAll('button')]
        .find((item) => item.innerText.trim() === ${JSON.stringify(text)} && !item.disabled)
      if (!button) return { clicked: false }
      button.click()
      return { clicked: true }
    })()`
  )
  if (!clicked.clicked) throw new Error(`Button ${text} is unavailable.`)
}

async function selectVariant(session, variant) {
  await clickButton(session, 'REGIONS')
  await clickButton(session, 'Model')
  await waitFor(session, (state) => state.group !== null, 'model selectors')
  await act(
    session,
    `(() => {
      const select = document.querySelector('#model-group')
      if (!select) return { changed: false }
      select.value = ${JSON.stringify(variant.groupId)}
      select.dispatchEvent(new Event('change', { bubbles: true }))
      return { changed: true }
    })()`
  )
  await waitFor(session, (state) => state.group === variant.groupId, `group ${variant.groupId}`)
  await act(
    session,
    `(() => {
      const select = document.querySelector('#model-mode')
      if (!select) return { changed: false }
      select.value = ${JSON.stringify(variant.id)}
      select.dispatchEvent(new Event('change', { bubbles: true }))
      return { changed: true }
    })()`
  )
  await waitFor(session, (state) => state.mode === variant.id, `mode ${variant.id}`)
}

async function runVariant(session, variant) {
  await clickButton(session, 'Run')
  const state = await waitFor(
    session,
    (current) =>
      current.buttons.some((button) => button.text === 'Commit') ||
      current.buttons.some((button) => button.text === 'Retry'),
    `model ${variant.id}`
  )
  if (state.buttons.some((button) => button.text === 'Retry')) {
    const line =
      state.text.split('\n').find((item) => item.includes('failed')) ?? 'Model execution failed.'
    throw new Error(`${variant.id}: ${line}`)
  }
  await clickButton(session, 'Commit')
  await waitFor(
    session,
    (current) =>
      current.buttons.some((button) => button.text === 'Export label map' && !button.disabled),
    `commit ${variant.id}`
  )
}

async function exportFilesIn(inputPath) {
  const dir = dirname(inputPath)
  const prefix = `${stripVolumeExtension(basename(inputPath))}.regions`
  return new Set(
    (await readdir(dir))
      .filter(
        (name) =>
          name.startsWith(prefix) &&
          (name.endsWith('.nii') || name.endsWith('.nii.gz') || name.endsWith('.txt'))
      )
      .map((name) => join(dir, name))
  )
}

async function waitForExport(inputPath, before) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const after = await exportFilesIn(inputPath)
    const created = [...after].filter((path) => !before.has(path))
    const label = created.find((path) => path.endsWith('.nii') || path.endsWith('.nii.gz'))
    const table = created.find((path) => path.endsWith('.txt'))
    if (label && table) return { label, table }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
  }
  throw new Error('Timed out waiting for exported files.')
}

async function moveFile(source, destination) {
  try {
    await rename(source, destination)
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
    await copyFile(source, destination)
    await rm(source)
  }
}

async function installGeneratedPair(generated, label, table, force) {
  await mkdir(dirname(label), { recursive: true })
  const existing = [await exists(label), await exists(table)]
  if (!force && existing.some(Boolean)) throw new Error(`Output already exists: ${label}`)
  const suffix = `${process.pid}-${Date.now()}`
  const staged = [`${label}.incoming-${suffix}`, `${table}.incoming-${suffix}`]
  const backups = [`${label}.replaced-${suffix}`, `${table}.replaced-${suffix}`]
  const destinations = [label, table]
  const backedUp = [false, false]
  const published = [false, false]
  try {
    await moveFile(generated.label, staged[0])
    await moveFile(generated.table, staged[1])
    for (let index = 0; index < existing.length; index++) {
      if (existing[index]) {
        await rename(destinations[index], backups[index])
        backedUp[index] = true
      }
    }
    for (let index = 0; index < staged.length; index++) {
      await rename(staged[index], destinations[index])
      published[index] = true
    }
    await Promise.all(backups.map((path) => rm(path, { force: true })))
  } catch (error) {
    for (let index = 0; index < published.length; index++) {
      if (published[index]) await rm(destinations[index], { force: true })
    }
    for (let index = 0; index < backedUp.length; index++) {
      if (backedUp[index] && (await exists(backups[index]))) {
        await rename(backups[index], destinations[index])
      }
    }
    throw error
  } finally {
    await Promise.all(staged.map((path) => rm(path, { force: true })))
  }
}

async function exportVariant(session, inputPath, output, variant, force) {
  const before = await exportFilesIn(inputPath)
  await clickButton(session, 'Export label map')
  const generated = await waitForExport(inputPath, before)
  const dir = join(output, 'candidate', modelReferenceSampleKey(inputPath))
  const labelExtension = generated.label.endsWith('.nii.gz') ? '.nii.gz' : '.nii'
  const label = join(dir, `${variant.id}${labelExtension}`)
  const table = join(dir, `${variant.id}.txt`)
  await installGeneratedPair(generated, label, table, force)
  return { label, table }
}

function referencePath(output, inputPath, variant) {
  return join(output, 'upstream', modelReferenceSampleKey(inputPath), `${variant.id}.nii.gz`)
}

async function existingCandidate(output, inputPath, variant) {
  const dir = join(output, 'candidate', modelReferenceSampleKey(inputPath))
  const table = join(dir, `${variant.id}.txt`)
  if (!(await exists(table))) return null
  for (const extension of ['.nii.gz', '.nii']) {
    const label = join(dir, `${variant.id}${extension}`)
    if (await exists(label)) return { label, table }
  }
  return null
}

async function main() {
  const options = parseModelAutomationArgs(process.argv.slice(2))
  await stat(APP_PATH)
  for (const job of options.jobs) await stat(job.inputPath)
  await mkdir(options.output, { recursive: true })
  let session = null
  const manifestPath = join(options.output, 'manifest.json')
  const manifest = (await exists(manifestPath))
    ? JSON.parse(await readFile(manifestPath, 'utf8'))
    : {}
  try {
    session = await launch()
    for (let index = 0; index < options.jobs.length; index++) {
      const job = options.jobs[index]
      console.log(
        `[${index + 1}/${options.jobs.length}] ${modelReferenceSampleKey(job.inputPath)} · ${job.variant.id}`
      )
      const existing = await existingCandidate(options.output, job.inputPath, job.variant)
      if (existing && !options.force) {
        throw new Error(`Output already exists: ${existing.label}. Pass --force to replace it.`)
      }
      await loadInput(session, job.inputPath)
      await selectVariant(session, job.variant)
      await runVariant(session, job.variant)
      const exported = await exportVariant(
        session,
        job.inputPath,
        options.output,
        job.variant,
        options.force
      )
      const entry = {
        inputPath: job.inputPath,
        candidatePath: exported.label,
        candidateTablePath: exported.table,
        referencePath: referencePath(options.output, job.inputPath, job.variant),
        referenceGridPath: join(
          options.output,
          'upstream-grid',
          `${modelReferenceSampleKey(job.inputPath)}.nii.gz`
        )
      }
      manifest[job.variant.id] = (manifest[job.variant.id] ?? []).filter(
        (item) => item.inputPath !== job.inputPath
      )
      manifest[job.variant.id].push(entry)
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    }
  } finally {
    if (session) await stop(session)
  }
  console.log(
    `Wrote ${options.jobs.length} candidate result(s) and ${join(options.output, 'manifest.json')}`
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
