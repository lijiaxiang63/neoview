import { describe, expect, it } from 'vitest'
import { join, resolve } from 'path'
import {
  createRendererMainFrameGate,
  externalWebUrl,
  ISOLATION_HEADERS,
  isolatedRendererResponse,
  rendererRequestPath,
  rendererServerUrl,
  rendererUrlIsTrusted
} from '../src/main/rendererProtocol'

describe('isolated renderer protocol', () => {
  it('uses the bundled protocol whenever no development server URL is present', () => {
    expect(rendererServerUrl(undefined)).toBeNull()
    expect(rendererServerUrl('')).toBeNull()
    expect(rendererServerUrl('   ')).toBeNull()
    expect(rendererServerUrl('http://localhost:5173')).toBe('http://localhost:5173')
  })

  it('maps only the renderer host and keeps decoded paths inside its root', () => {
    const root = resolve('bundle', 'renderer')
    expect(rendererRequestPath(root, 'app://renderer/')).toBe(join(root, 'index.html'))
    expect(rendererRequestPath(root, 'app://renderer/assets/main.js')).toBe(
      join(root, 'assets', 'main.js')
    )
    expect(rendererRequestPath(root, 'app://other/index.html')).toBeNull()
    expect(rendererRequestPath(root, 'https://renderer/index.html')).toBeNull()
    expect(rendererRequestPath(root, 'app://renderer/%2e%2e%2foutside')).toBeNull()
    expect(rendererRequestPath(root, 'app://renderer/%E0%A4%A')).toBeNull()
  })

  it('trusts only the packaged host or the configured development origin', () => {
    expect(rendererUrlIsTrusted('app://renderer/index.html', null)).toBe(true)
    expect(rendererUrlIsTrusted('app://other/index.html', null)).toBe(false)
    expect(rendererUrlIsTrusted('https://remote.test/', null)).toBe(false)
    expect(
      rendererUrlIsTrusted(
        'http://localhost:5173/another-document',
        'http://localhost:5173/index.html'
      )
    ).toBe(true)
    expect(rendererUrlIsTrusted('http://localhost:5174/', 'http://localhost:5173/index.html')).toBe(
      false
    )
  })

  it('requires both current-main-frame identity and a trusted URL', () => {
    const trusted = { url: 'app://renderer/index.html' }
    const remote = { url: 'https://remote.test/' }
    const gate = createRendererMainFrameGate(null)

    expect(gate({ sender: { mainFrame: trusted }, senderFrame: trusted })).toBe(true)
    expect(gate({ sender: { mainFrame: remote }, senderFrame: remote })).toBe(false)
    expect(gate({ sender: { mainFrame: trusted }, senderFrame: { ...trusted } })).toBe(false)
    expect(gate({ sender: { mainFrame: trusted }, senderFrame: null })).toBe(false)
  })

  it('externalizes only normal web links', () => {
    expect(externalWebUrl('https://example.test/path')).toBe('https://example.test/path')
    expect(externalWebUrl('app://renderer/index.html')).toBeNull()
    expect(externalWebUrl('file:///tmp/item')).toBeNull()
    expect(externalWebUrl('not a URL')).toBeNull()
  })

  it('preserves the streamed response while adding every isolation header', async () => {
    const wrapped = isolatedRendererResponse(
      new Response('payload', { status: 200, headers: { 'Content-Type': 'text/plain' } })
    )

    expect(await wrapped.text()).toBe('payload')
    expect(wrapped.headers.get('Content-Type')).toContain('text/plain')
    for (const [name, value] of Object.entries(ISOLATION_HEADERS)) {
      expect(wrapped.headers.get(name)).toBe(value)
    }
  })
})
