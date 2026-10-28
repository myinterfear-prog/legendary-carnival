/**
 * Relay core — routing, header hygiene, streaming and prefix handling.
 *
 * The relay is the single point where the origin's IP is hidden, so the
 * IP-strip assertions are security tests, not cosmetic ones.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  handleRelayRequest,
  resolveUpstream,
  RELAY_MARKER_HEADER,
  RELAY_REGION_HEADER
} from './handler.ts'

const GEMINI = 'https://generativelanguage.googleapis.com'
const ZEN = 'https://opencode.ai'

/** Swap global fetch for a recording stub. Returns the captured calls. */
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

const okResponse = () => json({ ok: true })

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('resolveUpstream — prefix routing', () => {
  test('/zen/ is forwarded verbatim to opencode.ai', () => {
    // Stripping "/zen" would rewrite the call onto a nonexistent route.
    expect(resolveUpstream('/zen/v1/chat/completions')).toEqual({
      origin: ZEN,
      path: '/zen/v1/chat/completions'
    })
  })

  test('/gemini/ is stripped and routed to the Gemini origin', () => {
    // Gemini has no "/gemini" surface — the prefix is synthetic routing sugar.
    expect(resolveUpstream('/gemini/v1beta/models/g:generateContent')).toEqual({
      origin: GEMINI,
      path: '/v1beta/models/g:generateContent'
    })
  })

  test('unprefixed paths keep the legacy Gemini passthrough', () => {
    expect(resolveUpstream('/v1beta/models/g:generateContent')).toEqual({
      origin: GEMINI,
      path: '/v1beta/models/g:generateContent'
    })
  })

  test('the query string is preserved on the forwarded path', async () => {
    const calls = stubFetch(() => okResponse())
    await handleRelayRequest(new Request('https://r.example/api/zen/v1/chat/completions?alt=sse'))
    expect(calls[0]!.url).toBe(`${ZEN}/zen/v1/chat/completions?alt=sse`)
  })
})

describe('platform prefix stripping', () => {
  test('a bare /api answers the health probe locally', async () => {
    stubFetch(() => {
      throw new Error('health probe must not reach an upstream')
    })
    const res = await handleRelayRequest(new Request('https://r.example/api'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, relay: 'cyberstream' })
  })

  test('/apix strips on a PATH BOUNDARY, not a bare prefix match', async () => {
    // "/apix/zen/..." also startsWith("/api". A naive slice yields
    // "x/zen/..." — a 404 from the wrong origin on EVERY request.
    const calls = stubFetch(() => okResponse())
    await handleRelayRequest(new Request('https://r.example/apix/zen/v1/chat/completions'))
    expect(calls[0]!.url).toBe(`${ZEN}/zen/v1/chat/completions`)
  })

  test('/api strips cleanly and leaves no residue', async () => {
    const calls = stubFetch(() => okResponse())
    await handleRelayRequest(new Request('https://r.example/api/zen/v1/chat/completions'))
    expect(calls[0]!.url).toBe(`${ZEN}/zen/v1/chat/completions`)
  })

  test('a path that merely resembles a prefix is left alone', async () => {
    const calls = stubFetch(() => okResponse())
    await handleRelayRequest(new Request('https://r.example/apifoo/zen/v1/chat/completions'))
    expect(calls[0]!.url).toBe(`${GEMINI}/apifoo/zen/v1/chat/completions`)
  })
})

describe('IP-leak prevention', () => {
  test('every ingress attribution header is stripped from the upstream request', async () => {
    const calls = stubFetch(() => okResponse())
    const headers: Record<string, string> = {
      'x-forwarded-for': '203.0.113.7',
      'x-real-ip': '203.0.113.7',
      'cf-connecting-ip': '203.0.113.7',
      forwarded: 'for=203.0.113.7',
      'true-client-ip': '203.0.113.7',
      'x-client-ip': '203.0.113.7',
      'x-forwarded-host': 'origin.internal',
      'originating-ip': '203.0.113.7'
    }
    await handleRelayRequest(
      new Request('https://r.example/api/gemini/v1beta/models/x', { headers })
    )

    const sent = calls[0]!.init!.headers as Headers
    for (const key of Object.keys(headers)) {
      expect(sent.get(key), `${key} must not reach the upstream`).toBeNull()
    }
  })

  test('authorization and content-type DO survive', async () => {
    const calls = stubFetch(() => okResponse())
    await handleRelayRequest(
      new Request('https://r.example/api/gemini/v1beta/models/x', {
        method: 'POST',
        headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
        body: '{"x":1}'
      })
    )
    const sent = calls[0]!.init!.headers as Headers
    expect(sent.get('authorization')).toBe('Bearer sk-test')
    expect(sent.get('content-type')).toContain('application/json')
  })
})

describe('streaming', () => {
  test('a successful body is forwarded UNREAD so SSE is not buffered', async () => {
    // A relay that calls .text() here would stall every stream until the
    // upstream finished — the exact failure mode long reasoning models hit.
    let pulled = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        pulled = true
        controller.enqueue(new TextEncoder().encode('data: {"a":1}\n\n'))
        controller.close()
      }
    })
    stubFetch(() => new Response(stream, { status: 200 }))

    const res = await handleRelayRequest(
      new Request('https://r.example/api/zen/v1/chat/completions', { method: 'POST' })
    )
    expect(pulled).toBe(true)
    expect(res.body).not.toBeNull()
    expect(await res.text()).toContain('"a":1')
  })

  test('the request body is forwarded unread for methods that carry one', async () => {
    const calls = stubFetch(() => okResponse())
    await handleRelayRequest(
      new Request('https://r.example/api/gemini/v1beta/models/x:generateContent', {
        method: 'POST',
        body: '{"contents":[]}'
      })
    )
    expect(calls[0]!.init!.body).toBeInstanceOf(ReadableStream)
  })

  test('GET and HEAD send no body', async () => {
    const calls = stubFetch(() => okResponse())
    await handleRelayRequest(new Request('https://r.example/api/gemini/v1beta/models'))
    await handleRelayRequest(
      new Request('https://r.example/api/gemini/v1beta/models', { method: 'HEAD' })
    )
    for (const call of calls) expect(call.init!.body).toBeUndefined()
  })

  test('stale framing headers are dropped so error bodies stay readable', async () => {
    // fetch() already decompresses; a stale content-length would make the
    // client re-inflate and see a garbled/empty error body.
    stubFetch(
      () =>
        new Response('Payment required', {
          status: 402,
          headers: {
            'content-encoding': 'gzip',
            'content-length': '9999',
            'transfer-encoding': 'chunked'
          }
        })
    )
    const res = await handleRelayRequest(
      new Request('https://r.example/api/zen/v1/chat/completions')
    )
    expect(res.headers.get('content-encoding')).toBeNull()
    expect(res.headers.get('content-length')).toBeNull()
    expect(res.headers.get('transfer-encoding')).toBeNull()
    expect(await res.text()).toBe('Payment required')
  })

  test('an upstream error status and body are preserved verbatim', async () => {
    // The proxy attributes billing faults from this exact body — mangling it
    // would break relay-vs-model attribution.
    const body = 'Payment required\n\nDEPLOYMENT_DISABLED\n\nsin1::abc'
    stubFetch(() => new Response(body, { status: 402 }))
    const res = await handleRelayRequest(
      new Request('https://r.example/api/zen/v1/chat/completions')
    )
    expect(res.status).toBe(402)
    expect(await res.text()).toBe(body)
  })

  test('a dead upstream becomes 502, never an unhandled throw', async () => {
    stubFetch(() => {
      throw new Error('ECONNREFUSED')
    })
    const res = await handleRelayRequest(
      new Request('https://r.example/api/gemini/v1beta/models/x')
    )
    expect(res.status).toBe(502)
    expect(await res.json()).toMatchObject({ error: 'Relay upstream fetch failed' })
  })
})

describe('CORS + diagnostics', () => {
  test('OPTIONS short-circuits with a permissive preflight', async () => {
    const calls = stubFetch(() => okResponse())
    const res = await handleRelayRequest(
      new Request('https://r.example/api/zen/v1/chat/completions', { method: 'OPTIONS' })
    )
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    // A preflight must never be forwarded upstream.
    expect(calls).toHaveLength(0)
  })

  test('the relay marker is present on proxied responses', async () => {
    stubFetch(() => okResponse())
    const res = await handleRelayRequest(new Request('https://r.example/api/gemini/v1beta/models'))
    expect(res.headers.get(RELAY_MARKER_HEADER)).toBe('true')
  })

  test('the region header appears only when the platform supplies one', async () => {
    stubFetch(() => okResponse())
    const bare = await handleRelayRequest(new Request('https://r.example/api/gemini/v1beta/models'))
    expect(bare.headers.get(RELAY_REGION_HEADER)).toBeNull()

    const tagged = await handleRelayRequest(
      new Request('https://r.example/api/gemini/v1beta/models'),
      { region: 'us-east-1' }
    )
    expect(tagged.headers.get(RELAY_REGION_HEADER)).toBe('us-east-1')
  })
})
