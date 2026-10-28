/**
 * CyberStream Relay — portable request handler.
 *
 * Single Responsibility: Forward one inbound request to the correct upstream
 * AI provider, stripping client-IP headers and preserving SSE streaming. This
 * module owns ALL relay behaviour; every platform adapter is a thin wrapper
 * that calls `handleRelayRequest`.
 *
 * WHY A CORE
 * ----------
 * The handler is pure Web-standard (`Request` → `Response`), so one
 * implementation serves every runtime:
 *   - Vercel Edge Functions    (V8 isolate)      → `api/index.ts`
 *   - Netlify Edge Functions   (Deno)            → `netlify/edge-functions/relay.ts`
 *   - Netlify Functions        (Node / Lambda)   → `netlify/functions/relay.ts`
 *
 * Duplicating the routing table per platform is how the paths drift apart and
 * a fix lands on one host only.
 *
 * SECURITY
 * --------
 * Zero application-level auth by design — the relay is a pure forward proxy
 * and holds no credentials. `IP_LEAK_HEADERS` is scrubbed on EVERY request:
 * that stripping is the entire point of the relay, and forwarding a client's
 * `x-forwarded-for` would defeat it by handing the upstream a map straight to
 * the origin.
 *
 * STREAMING
 * ---------
 * Successful responses are returned with `upstreamResponse.body` UNREAD, so
 * SSE tokens reach the caller as the upstream emits them. Never buffer here.
 *
 * PLATFORM LIMITS (read before deploying)
 * ----------------------------------------
 * Netlify standard Functions impose a **60-second synchronous execution cap
 * that cannot be configured**, and Netlify Edge Functions impose a **40-second
 * response-header timeout**. Both are far below this proxy's 32-minute request
 * budget, so long thinking-model streams only survive on a runtime without a
 * total-duration cap. See README.md.
 */

/** Synthetic prefixes each platform routes to this function. */
const PLATFORM_PREFIXES = ['/api', '/apix'] as const

const GEMINI_ORIGIN = 'https://generativelanguage.googleapis.com'
const ZEN_ORIGIN = 'https://opencode.ai'

/**
 * First matching prefix wins. The boolean marks synthetic prefixes that must
 * be stripped before forwarding: Gemini's API surface has no "/gemini" path,
 * while OpenCode Zen's REAL API lives under "/zen/*" — stripping it rewrites
 * every call onto a nonexistent upstream route (guaranteed empty-ish 404s).
 */
const PREFIX_ROUTES: ReadonlyArray<readonly [prefix: string, origin: string, strip: boolean]> = [
  ['/zen/', ZEN_ORIGIN, false],
  ['/gemini/', GEMINI_ORIGIN, true]
]

/**
 * Headers that would hand the upstream the client's real address.
 *
 * Scrubbed in BOTH directions of intent: Netlify/Vercel/CDN ingress headers are
 * stripped from the outbound request so egress masking survives the hop.
 */
const IP_LEAK_HEADERS = [
  'x-forwarded-for',
  'x-real-ip',
  'cf-connecting-ip',
  'cf-ipcountry',
  'true-client-ip',
  'forwarded',
  'x-client-ip',
  'x-cluster-client-ip',
  'x-forwarded',
  'x-forwarded-host',
  'originating-ip',
  'x-custom-ip'
]

/**
 * Max bytes to buffer for non-2xx error responses. API error bodies are
 * typically < 1 KB; 64 KB covers even verbose provider error pages without
 * risking OOM on a constrained memory envelope.
 */
const MAX_ERROR_BODY_BYTES = 65_536

/** Identifies a relayed response, so an operator can confirm the hop was used. */
export const RELAY_MARKER_HEADER = 'X-CyberStream-Relay'
/** Deployment region label, when the platform exposes one. */
export const RELAY_REGION_HEADER = 'X-CyberStream-Region'

export interface RelayContext {
  /**
   * Platform region label surfaced as `X-CyberStream-Region`. Optional —
   * not every runtime exposes one. Purely diagnostic: it lets a client
   * correlate a slow response with the hop that served it.
   */
  readonly region?: string | undefined
}

/** Resolve the upstream origin + path for an inbound request. */
export function resolveUpstream(upstreamPath: string): {
  readonly origin: string
  readonly path: string
} {
  for (const [prefix, origin, strip] of PREFIX_ROUTES) {
    if (upstreamPath.startsWith(prefix)) {
      return { origin, path: strip ? upstreamPath.slice(prefix.length - 1) : upstreamPath }
    }
  }
  // Legacy passthrough: unprefixed paths target the Gemini origin so
  // pre-existing single-upstream relay URLs keep working.
  return { origin: GEMINI_ORIGIN, path: upstreamPath }
}

function json(body: string, status: number, region?: string): Response {
  const headers = new Headers({ 'Content-Type': 'application/json', [RELAY_MARKER_HEADER]: 'true' })
  if (region) headers.set(RELAY_REGION_HEADER, region)
  return new Response(body, { status, headers })
}

/**
 * Handle one relayed request.
 *
 * @param req       Inbound request. Its body is forwarded unread for methods
 *                  that carry one.
 * @param context   Platform metadata (region label). See {@link RelayContext}.
 */
export async function handleRelayRequest(
  req: Request,
  context: RelayContext = {}
): Promise<Response> {
  const region = context.region

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Max-Age': '86400'
      }
    })
  }

  const url = new URL(req.url)

  // Strip the platform prefix that routing / baseUrl adds. Adapters mount the
  // function at `/api/*` (or `/apix/*` for the Lambda variant).
  //
  // Matching is on a PATH BOUNDARY, not a bare `startsWith`: `/apix/zen/...`
  // also starts with `/api`, and a naive prefix slice would yield
  // `x/zen/...` — a 404 from the wrong origin on every request.
  let upstreamPath = url.pathname
  for (const prefix of PLATFORM_PREFIXES) {
    if (upstreamPath === prefix || upstreamPath.startsWith(`${prefix}/`)) {
      upstreamPath = upstreamPath.slice(prefix.length)
      break
    }
  }
  upstreamPath += url.search

  // Health / probe hit a bare prefix — reply locally so a client can
  // distinguish "relay alive" from upstream auth errors.
  if (!upstreamPath || upstreamPath === '/') {
    return json(JSON.stringify({ ok: true, relay: 'cyberstream' }), 200, region)
  }

  const headers = new Headers(req.headers)
  for (const h of IP_LEAK_HEADERS) {
    headers.delete(h)
  }

  const { origin, path } = resolveUpstream(upstreamPath)
  const upstreamUrl = `${origin}${path}`

  let upstreamResponse: Response
  try {
    upstreamResponse = await fetch(upstreamUrl, {
      method: req.method,
      headers,
      // Forwarded unread — buffering here would break SSE entirely.
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body,
      redirect: 'follow'
    })
  } catch (err) {
    console.error(`Relay upstream fetch failed for ${upstreamUrl}:`, err)
    return json(
      JSON.stringify({ error: 'Relay upstream fetch failed', detail: String(err) }),
      502,
      region
    )
  }

  const responseHeaders = new Headers(upstreamResponse.headers)
  // The body stream below arrives already-decompressed by fetch(); stale
  // framing headers from the compressed wire payload would make clients
  // re-inflate decoded bytes — garbling or emptying error bodies entirely.
  responseHeaders.delete('content-encoding')
  responseHeaders.delete('content-length')
  responseHeaders.delete('transfer-encoding')
  responseHeaders.set('Access-Control-Allow-Origin', '*')
  responseHeaders.set(RELAY_MARKER_HEADER, 'true')
  if (region) responseHeaders.set(RELAY_REGION_HEADER, region)

  if (!upstreamResponse.ok) {
    const errorBody = (await upstreamResponse.text()).slice(0, MAX_ERROR_BODY_BYTES)
    console.error(`Relay upstream error for ${upstreamUrl}:`, errorBody)
    return new Response(errorBody, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders
    })
  }

  // Streamed: the body is never read here.
  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders
  })
}
