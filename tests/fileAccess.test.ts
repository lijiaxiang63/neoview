import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileAccessAuthorizer, isPathWithin } from '../src/main/files/access'

const tempDirs: string[] = []

async function tempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'neoview-access-'))
  tempDirs.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function activate(
  access: FileAccessAuthorizer,
  ownerId: number,
  root: string
): Promise<void> {
  const request = access.beginScan(ownerId)
  const prepared = await access.prepareScan(request, root)
  expect(prepared).not.toBeNull()
  expect(access.activateScan(prepared!)).toBe(true)
}

describe('file access authorization', () => {
  it('distinguishes descendants from similar path prefixes', () => {
    expect(isPathWithin('/data/set', '/data/set/a.nii')).toBe(true)
    expect(isPathWithin('/data/set', '/data/set-two/a.nii')).toBe(false)
    expect(isPathWithin('/data/set', '/data/set')).toBe(true)
  })

  it('rejects a symlink whose real target escapes the authorized root', async () => {
    const base = await tempDir()
    const root = join(base, 'root')
    const outside = join(base, 'outside')
    await mkdir(root)
    await mkdir(outside)
    const target = join(outside, 'target.nii')
    const link = join(root, 'link.nii')
    await writeFile(target, 'x')
    await symlink(target, link)
    const access = new FileAccessAuthorizer({ realpath })
    await activate(access, 1, root)

    await expect(access.authorizeRead(1, link)).rejects.toThrow('outside the opened folder')
  })

  it('isolates roots between webContents owners', async () => {
    const base = await tempDir()
    const one = join(base, 'one')
    const two = join(base, 'two')
    await mkdir(one)
    await mkdir(two)
    const oneFile = join(one, 'a.nii')
    const twoFile = join(two, 'b.nii')
    await writeFile(oneFile, 'a')
    await writeFile(twoFile, 'b')
    const access = new FileAccessAuthorizer({ realpath })
    await activate(access, 11, one)
    await activate(access, 22, two)

    await expect(access.authorizeRead(11, oneFile)).resolves.toMatchObject({
      realPath: await realpath(oneFile)
    })
    await expect(access.authorizeRead(11, twoFile)).rejects.toThrow('outside')
    await expect(access.authorizeRead(22, oneFile)).rejects.toThrow('outside')
  })

  it('preserves active access on cancellation, replaces it on activation, and rejects stale scans', async () => {
    const base = await tempDir()
    const oldRoot = join(base, 'old')
    const newRoot = join(base, 'new')
    await mkdir(oldRoot)
    await mkdir(newRoot)
    const access = new FileAccessAuthorizer({ realpath })
    await activate(access, 7, oldRoot)

    const canceled = access.beginScan(7)
    expect(access.activeRoot(7)).toBe(await realpath(oldRoot))
    access.cancelScan(7)
    expect(access.activeRoot(7)).toBe(await realpath(oldRoot))

    const stalePrepared = await access.prepareScan(canceled, newRoot)
    expect(stalePrepared).toBeNull()

    const current = access.beginScan(7)
    const prepared = await access.prepareScan(current, newRoot)
    expect(access.activateScan(prepared!)).toBe(true)
    expect(access.activeRoot(7)).toBe(await realpath(newRoot))

    access.cancelScan(7)
    expect(access.activeRoot(7)).toBe(await realpath(oldRoot))

    const confirmed = access.beginScan(7)
    const confirmedPrepared = await access.prepareScan(confirmed, newRoot)
    expect(access.activateScan(confirmedPrepared!)).toBe(true)
    expect(access.confirmScan(confirmedPrepared!)).toBe(true)
    access.cancelScan(7)
    expect(access.activeRoot(7)).toBe(await realpath(newRoot))

    access.release(7)
    expect(access.activeRoot(7)).toBeNull()
    expect(access.activateScan(confirmedPrepared!)).toBe(false)
  })
})
