import { resolve, sep } from 'path'

export const RENDERER_SCHEME = 'app'
export const RENDERER_ORIGIN = `${RENDERER_SCHEME}://renderer`

export interface RendererFrameEventLike {
  sender: { mainFrame: { url: string } }
  senderFrame: { url: string } | null
}

export type RendererMainFrameGate = (event: RendererFrameEventLike) => boolean

/** Development uses Vite's server when its URL is present. Preview and
 * packaged builds both serve the bundled renderer through the secure origin. */
export function rendererServerUrl(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/** Only the packaged renderer origin, or the configured development origin,
 * may retain access to the preload bridge after a document navigation. */
export function rendererUrlIsTrusted(url: string, developmentUrl: string | null): boolean {
  let candidate: URL
  try {
    candidate = new URL(url)
  } catch {
    return false
  }
  if (candidate.protocol === `${RENDERER_SCHEME}:` && candidate.host === 'renderer') return true
  if (!developmentUrl) return false
  try {
    const development = new URL(developmentUrl)
    return (
      (development.protocol === 'http:' || development.protocol === 'https:') &&
      candidate.origin === development.origin
    )
  } catch {
    return false
  }
}

export function createRendererMainFrameGate(developmentUrl: string | null): RendererMainFrameGate {
  return (event) =>
    event.senderFrame !== null &&
    event.senderFrame === event.sender.mainFrame &&
    rendererUrlIsTrusted(event.senderFrame.url, developmentUrl)
}

/** External navigation is deliberately narrower than renderer trust: only
 * normal web links are handed to the operating system. */
export function externalWebUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

export const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin'
} as const

/** Resolve one custom-protocol request inside the bundled renderer root.
 * Encoded traversal and a foreign host are rejected before filesystem I/O. */
export function rendererRequestPath(root: string, requestUrl: string): string | null {
  let url: URL
  try {
    url = new URL(requestUrl)
  } catch {
    return null
  }
  if (url.protocol !== `${RENDERER_SCHEME}:` || url.host !== 'renderer') return null
  let relative: string
  try {
    relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html'
  } catch {
    return null
  }
  const absoluteRoot = resolve(root)
  const path = resolve(absoluteRoot, relative)
  return path === absoluteRoot || path.startsWith(`${absoluteRoot}${sep}`) ? path : null
}

/** Wrap a streamed local response with the headers Chromium requires before
 * exposing shared memory to the renderer and its dedicated workers. */
export function isolatedRendererResponse(response: Response): Response {
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(ISOLATION_HEADERS)) headers.set(name, value)
  return new Response(response.body, {
    status: response.status || 200,
    statusText: response.statusText,
    headers
  })
}
