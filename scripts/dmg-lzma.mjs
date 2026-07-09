/**
 * electron-builder afterAllArtifactBuild hook: recompress each dmg with LZMA
 * (ULMO), ~17% smaller than the bzip2 image `compression: maximum` produces.
 * ULMO needs macOS 10.15+ to mount — well below what the app itself requires.
 * The stale .blockmap is deleted rather than regenerated: the in-app updater
 * downloads whole files and never reads blockmaps.
 */
import { execFileSync } from 'node:child_process'
import { renameSync, rmSync } from 'node:fs'

export default function afterAllArtifactBuild({ artifactPaths }) {
  for (const artifact of artifactPaths) {
    if (!artifact.endsWith('.dmg')) continue
    const tmp = `${artifact}.tmp.dmg`
    execFileSync('hdiutil', ['convert', artifact, '-format', 'ULMO', '-o', tmp, '-quiet'])
    rmSync(artifact)
    renameSync(tmp, artifact)
    rmSync(`${artifact}.blockmap`, { force: true })
  }
  return []
}
