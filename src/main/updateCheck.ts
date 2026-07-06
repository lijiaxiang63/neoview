/**
 * Pure logic for the update checker: version comparison and picking the right
 * installer asset for this platform/arch out of a release's asset list.
 * No Electron imports so it stays unit-testable.
 */

export interface ReleaseAsset {
  name: string
  /** Direct download URL. */
  url: string
  size: number
  /** "sha256:<hex>" when the release API provides an integrity digest. */
  digest: string | null
}

export interface UpdateInfo {
  /** Newer version, without any leading 'v'. */
  version: string
  /** Human-readable release page (notes). */
  notesUrl: string
  asset: ReleaseAsset
}

/** The subset of a release API response the checker relies on. */
export interface ReleaseJson {
  tag_name?: string
  html_url?: string
  draft?: boolean
  prerelease?: boolean
  assets?: Array<{
    name?: string
    browser_download_url?: string
    size?: number
    digest?: string | null
  }>
}

/** Dotted-numeric compare ignoring a leading 'v'; positive when a > b. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v
      .replace(/^v/i, '')
      .split('.')
      .map((part) => parseInt(part, 10) || 0)
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

const ARCH_TOKENS: Record<string, RegExp> = {
  arm64: /arm64|aarch64/i,
  x64: /x64|x86[-_]?64|amd64|intel/i
}

/**
 * Rank an asset name for the running arch: explicit match > universal >
 * unmarked; an explicit *other* arch is disqualifying (negative).
 */
function archScore(name: string, arch: string): number {
  const mine = ARCH_TOKENS[arch]
  if (mine?.test(name)) return 2
  if (/universal/i.test(name)) return 1
  for (const [key, re] of Object.entries(ARCH_TOKENS)) {
    if (key !== arch && re.test(name)) return -1
  }
  return 0
}

/** Installer extensions per platform, in preference order. */
const EXT_GROUPS: Record<string, string[][]> = {
  darwin: [['.dmg']],
  win32: [['.exe']],
  linux: [['.appimage'], ['.deb']]
}

export function pickAsset(
  assets: ReleaseAsset[],
  platform: string,
  arch: string
): ReleaseAsset | null {
  for (const exts of EXT_GROUPS[platform] ?? []) {
    let best: ReleaseAsset | null = null
    let bestScore = -1
    for (const asset of assets) {
      const name = asset.name.toLowerCase()
      if (!exts.some((ext) => name.endsWith(ext))) continue
      const score = archScore(asset.name, arch)
      if (score > bestScore) {
        best = asset
        bestScore = score
      }
    }
    if (best) return best
  }
  return null
}

/** Null when the release is not a newer, installable version for us. */
export function findUpdate(
  release: ReleaseJson,
  currentVersion: string,
  platform: string,
  arch: string
): UpdateInfo | null {
  if (release.draft || release.prerelease) return null
  const tag = release.tag_name
  if (typeof tag !== 'string' || compareVersions(tag, currentVersion) <= 0) return null
  const assets: ReleaseAsset[] = []
  for (const a of release.assets ?? []) {
    if (typeof a.name !== 'string' || typeof a.browser_download_url !== 'string') continue
    assets.push({
      name: a.name,
      url: a.browser_download_url,
      size: typeof a.size === 'number' ? a.size : 0,
      digest: typeof a.digest === 'string' ? a.digest : null
    })
  }
  const asset = pickAsset(assets, platform, arch)
  if (!asset) return null
  return { version: tag.replace(/^v/i, ''), notesUrl: release.html_url ?? '', asset }
}
