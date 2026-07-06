import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  findUpdate,
  pickAsset,
  type ReleaseAsset,
  type ReleaseJson
} from '../src/main/updateCheck'

function asset(name: string, extra: Partial<ReleaseAsset> = {}): ReleaseAsset {
  return { name, url: `https://example.test/${name}`, size: 1000, digest: null, ...extra }
}

describe('compareVersions', () => {
  it('treats equal versions as equal, with or without a leading v', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('1.0', '1.0.0')).toBe(0)
  })

  it('compares components numerically, not lexically', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0)
    expect(compareVersions('0.9.0', '0.10.0')).toBeLessThan(0)
  })

  it('handles different component counts', () => {
    expect(compareVersions('2.0', '1.9.9')).toBeGreaterThan(0)
    expect(compareVersions('1.0.1', '1.0')).toBeGreaterThan(0)
  })
})

describe('pickAsset', () => {
  const all = [
    asset('app-1.1.0-setup.exe'),
    asset('app-1.1.0.dmg'),
    asset('app-1.1.0.AppImage'),
    asset('app_1.1.0_amd64.deb'),
    asset('app-1.1.0.zip')
  ]

  it('picks the installer for each platform', () => {
    expect(pickAsset(all, 'darwin', 'arm64')?.name).toBe('app-1.1.0.dmg')
    expect(pickAsset(all, 'win32', 'x64')?.name).toBe('app-1.1.0-setup.exe')
    expect(pickAsset(all, 'linux', 'x64')?.name).toBe('app-1.1.0.AppImage')
  })

  it('falls back to .deb when no .AppImage exists', () => {
    const noAppImage = all.filter((a) => !a.name.endsWith('.AppImage'))
    expect(pickAsset(noAppImage, 'linux', 'x64')?.name).toBe('app_1.1.0_amd64.deb')
  })

  it('prefers the matching arch when assets are arch-tagged', () => {
    const tagged = [asset('app-arm64.dmg'), asset('app-x64.dmg')]
    expect(pickAsset(tagged, 'darwin', 'arm64')?.name).toBe('app-arm64.dmg')
    expect(pickAsset(tagged, 'darwin', 'x64')?.name).toBe('app-x64.dmg')
  })

  it('prefers universal over unmarked, and rejects a lone wrong-arch asset', () => {
    expect(pickAsset([asset('app.dmg'), asset('app-universal.dmg')], 'darwin', 'arm64')?.name).toBe(
      'app-universal.dmg'
    )
    expect(pickAsset([asset('app-x64.dmg')], 'darwin', 'arm64')).toBeNull()
  })

  it('returns null when nothing matches the platform', () => {
    expect(pickAsset([asset('app.dmg')], 'win32', 'x64')).toBeNull()
    expect(pickAsset([], 'darwin', 'arm64')).toBeNull()
  })
})

describe('findUpdate', () => {
  const release: ReleaseJson = {
    tag_name: 'v1.1.0',
    html_url: 'https://example.test/releases/v1.1.0',
    assets: [
      {
        name: 'app-1.1.0.dmg',
        browser_download_url: 'https://example.test/app-1.1.0.dmg',
        size: 12345,
        digest: 'sha256:abc'
      },
      {
        name: 'app-1.1.0-setup.exe',
        browser_download_url: 'https://example.test/app-1.1.0-setup.exe',
        size: 23456
      }
    ]
  }

  it('reports a newer release with the platform asset and stripped version', () => {
    const update = findUpdate(release, '1.0.0', 'darwin', 'arm64')
    expect(update).not.toBeNull()
    expect(update?.version).toBe('1.1.0')
    expect(update?.notesUrl).toBe('https://example.test/releases/v1.1.0')
    expect(update?.asset.name).toBe('app-1.1.0.dmg')
    expect(update?.asset.size).toBe(12345)
    expect(update?.asset.digest).toBe('sha256:abc')
  })

  it('defaults a missing digest to null', () => {
    expect(findUpdate(release, '1.0.0', 'win32', 'x64')?.asset.digest).toBeNull()
  })

  it('returns null for same, older, draft and prerelease versions', () => {
    expect(findUpdate(release, '1.1.0', 'darwin', 'arm64')).toBeNull()
    expect(findUpdate(release, '1.2.0', 'darwin', 'arm64')).toBeNull()
    expect(findUpdate({ ...release, draft: true }, '1.0.0', 'darwin', 'arm64')).toBeNull()
    expect(findUpdate({ ...release, prerelease: true }, '1.0.0', 'darwin', 'arm64')).toBeNull()
  })

  it('returns null when the release has no asset for this platform', () => {
    expect(findUpdate(release, '1.0.0', 'linux', 'x64')).toBeNull()
  })

  it('ignores malformed asset entries', () => {
    const broken: ReleaseJson = {
      tag_name: 'v9.9.9',
      assets: [{ name: 'app.dmg' }, { browser_download_url: 'https://example.test/x' }]
    }
    expect(findUpdate(broken, '1.0.0', 'darwin', 'arm64')).toBeNull()
  })
})
