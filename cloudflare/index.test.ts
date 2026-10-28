/**
 * Cloudflare Workers adapter tests.
 *
 * Verifies that the Cloudflare Worker default export conforms to the
 * Module Worker `fetch` interface, passes requests to `handleRelayRequest`,
 * and extracts the Cloudflare edge PoP (`request.cf.colo`) into the
 * `X-CyberStream-Region` diagnostic header.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import worker from './index.ts'
import { RELAY_MARKER_HEADER, RELAY_REGION_HEADER } from '../core/handler.ts'

const ZEN = 'https://opencode.ai'

function stubFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      return impl(url, init)
    })
  )
  return calls
}

function json(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Cloudflare Workers adapter', () => {
  test('exports an object with a fetch handler', () => {
    expect(worker).toBeDefined()
    expect(typeof worker.fetch).toBe('function')
  })

  test('answers bare health probe without cf object', async () => {
    const req = new Request('https://relay.workers.dev/api')
    const res = await worker.fetch(req)
    expect(res.status).toBe(200)
    expect(res.headers.get(RELAY_MARKER_HEADER)).toBe('true')
    expect(res.headers.get(RELAY_REGION_HEADER)).toBeNull()
    expect(await res.json()).toEqual({ ok: true, relay: 'cyberstream' })
  })

  test('extracts request.cf.colo and stamps X-CyberStream-Region', async () => {
    const req = new Request('https://relay.workers.dev/api')
    Object.defineProperty(req, 'cf', {
      value: { colo: 'IAD', country: 'US' },
      writable: true,
      configurable: true
    })

    const res = await worker.fetch(req)
    expect(res.status).toBe(200)
    expect(res.headers.get(RELAY_MARKER_HEADER)).toBe('true')
    expect(res.headers.get(RELAY_REGION_HEADER)).toBe('IAD')
  })

  test('ignores non-string or empty colo gracefully', async () => {
    const req = new Request('https://relay.workers.dev/api')
    Object.defineProperty(req, 'cf', {
      value: { colo: '', country: 'US' },
      writable: true,
      configurable: true
    })

    const res = await worker.fetch(req)
    expect(res.status).toBe(200)
    expect(res.headers.get(RELAY_REGION_HEADER)).toBeNull()
  })

  test('forwards proxied chat requests with edge colo header preserved', async () => {
    const calls = stubFetch(() => json({ id: 'chatcmpl-test', choices: [] }))

    const req = new Request('https://relay.workers.dev/api/zen/v1/chat/completions', {
      method: 'POST',
      headers: {
        authorization: 'Bearer zen-test-key',
        'content-type': 'application/json',
        'cf-connecting-ip': '1.2.3.4',
        'x-forwarded-for': '1.2.3.4'
      },
      body: JSON.stringify({ model: 'zen-model', messages: [] })
    })
    Object.defineProperty(req, 'cf', {
      value: { colo: 'SIN', country: 'SG' },
      writable: true,
      configurable: true
    })

    const res = await worker.fetch(req)
    expect(res.status).toBe(200)
    expect(res.headers.get(RELAY_MARKER_HEADER)).toBe('true')
    expect(res.headers.get(RELAY_REGION_HEADER)).toBe('SIN')

    // Verify upstream call
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${ZEN}/zen/v1/chat/completions`)
    const forwardedHeaders = calls[0]!.init!.headers as Headers
    expect(forwardedHeaders.get('authorization')).toBe('Bearer zen-test-key')
    expect(forwardedHeaders.get('cf-connecting-ip')).toBeNull()
    expect(forwardedHeaders.get('x-forwarded-for')).toBeNull()
  })
})
