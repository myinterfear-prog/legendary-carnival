# CyberStream Relay

Transparent forward proxy for upstream AI provider traffic. Egresses from the CDN's
edge IPs, masking the origin server's real address, so a provider never sees the
proxy host's IP.

**Single Responsibility:** `core/handler.ts` owns all routing and header hygiene.
Every platform adapter is a thin wrapper around it — see [Architecture](#architecture).

---

## Deploy targets

| Target                     | Path      | Runtime          | Streaming  | Duration limit             | Status                            |
| -------------------------- | --------- | ---------------- | ---------- | -------------------------- | --------------------------------- |
| **Cloudflare Workers**     | `/*`      | workerd (V8)     | ✅         | Unlimited network stream   | ✅ **Recommended Edge Target**    |
| **Netlify Edge Functions** | `/api/*`  | Deno             | ✅         | 40 s to _headers_ only     | ✅ **Recommended for Netlify**    |
| Netlify standard Functions | `/apix/*` | Node 22 / Lambda | ✅ (20 MB) | **60 s, not configurable** | ⚠️ See [limits](#platform-limits) |
| Vercel Edge Functions      | `/api/*`  | V8 isolate       | ✅         | 300 s                      | ✅ Existing production target     |

---

## Platform limits — read before deploying

This proxy's request budget is **32 minutes** (`REQUEST_TIMEOUT_MS` in the proxy), and
thinking models routinely stream for minutes. That single fact drives the whole target
selection:

- **Cloudflare Workers runs on the workerd V8 engine across 330+ edge locations.** Duration
  limits apply to active CPU time (50 ms Free, up to 30 s–5 m Paid), but waiting for upstream
  HTTP network I/O and streaming SSE chunks does NOT count against CPU time. Long reasoning
  model streams survive indefinitely on Workers, and `request.cf.colo` (e.g. `SFO`, `LHR`, `NRT`)
  is automatically exposed via `X-CyberStream-Region` for edge latency telemetry.
- **Netlify standard Functions impose a 60-second synchronous execution cap that cannot
  be configured.** Any request exceeding it is killed by the platform and returned as a
  gateway error. Worse, the proxy's relay health tracker would _correctly_ charge that
  failure to the hop — draining a healthy deployment out of the pool for something it
  cannot control. **Use `/apix/*` only for workloads you know finish inside 60 s**
  (model catalog fetches, short non-thinking completions).
- **Netlify Edge Functions impose a 40-second response-header timeout**, not a total
  duration cap, and bill only 50 ms of CPU per request (time spent waiting on the
  upstream is excluded). Providers send headers immediately, so long streams survive.

Netlify standard Functions run in a single region (`cmh`/Ohio by default) and cannot be
geo-routed within one site. For real geo-spreading, deploy **multiple Netlify sites** in
different regions and list them all in the proxy's `RELAY_URLS` — the proxy selects one
per request from the healthy set.

---

## Deploy

### Cloudflare Workers (Recommended)

```bash
npm install
npx wrangler login           # if not already authenticated
npm run deploy:cf            # wrangler deploy
```

Local development:

```bash
npm run dev:cf               # wrangler dev
```

Verify after deploy:

```bash
curl -i https://<worker-name>.<subdomain>.workers.dev/api/         # → 200 {"ok":true,"relay":"cyberstream"}
```

Cloudflare Workers handles any path (`/api/*` or unprefixed `/*`), making it compatible
with either `RELAY_URLS=https://<worker>.<subdomain>.workers.dev/api` or
`RELAY_URLS=https://<worker>.<subdomain>.workers.dev`.

### Netlify (Edge Functions — recommended)

```bash
npm install
npx netlify login
npx netlify init --dir .      # base directory = relay/
npm run deploy:netlify
```

Both function targets declare `config.path` in source, so no redirect rules are needed.

The relay publishes no static assets — `publish = "dist"` exists only because Netlify
requires a publish path.

Verify after deploy:

```bash
curl -i https://<site>.netlify.app/api/         # → 200 {"ok":true,"relay":"cyberstream"}
```

Note the **trailing slash**. Netlify's `path: "/api/*"` requires at least one segment
after the prefix, so bare `/api` is handled by Netlify's static router and 404s. The
Lambda variant behaves the same way (`/apix/` works, `/apix` does not).

This has no effect on proxy traffic — the proxy always appends a real path
(`/api/zen/v1/chat/completions`, `/api/v1beta/models/...`), never a bare prefix.

### Vercel

```bash
npm run dev          # vercel dev
npm run deploy:vercel
```

`vercel.json` rewrites every path into `api/index.ts`.

---

## Wire it into the proxy

Add the deployed URL to `RELAY_URLS` (must include the path prefix) and list the
provider in `RELAY_PROVIDERS` if not already there:

```
RELAY_URLS=https://<site>.netlify.app/api
RELAY_PROVIDERS=Gemini/API,OpenCode/Zen
```

Or at runtime via `PATCH /v1/config` with `{ "relayUrls": [...] }` — this takes effect
on the next request, no restart required.

---

## Routing

Path-prefix routing, evaluated after the platform prefix (`/api` or `/apix`) is
stripped:

| Inbound                                       | Outgoing                                                                                         |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `/api/zen/v1/chat/completions`                | `https://opencode.ai/zen/v1/chat/completions`                                                    |
| `/api/gemini/v1beta/models/x:generateContent` | `https://generativelanguage.googleapis.com/v1beta/models/x:generateContent`                      |
| `/api/v1beta/models/x:generateContent`        | `https://generativelanguage.googleapis.com/v1beta/models/x:generateContent` (legacy passthrough) |
| `/api/` (bare, trailing slash)                | local health response — `{"ok":true,"relay":"cyberstream"}`                                      |

`/zen` is part of Zen's **real** API surface and is forwarded verbatim; `/gemini` is
synthetic routing sugar and is stripped. Getting that backwards rewrites every call onto
a nonexistent upstream route.

Platform-prefix stripping matches on a **path boundary**, not a bare `startsWith`:
`/apix/zen/...` also starts with `/api`, and a naive prefix slice yields `x/zen/...` — a
404 from the wrong origin on every request.

---

## Security

The relay has **zero application-level authentication** by design — it is a pure forward
proxy that stores no credentials.

Every request has these headers stripped before it reaches the upstream:
`x-forwarded-for`, `x-real-ip`, `cf-connecting-ip`, `cf-ipcountry`, `true-client-ip`,
`forwarded`, `x-client-ip`, `x-cluster-client-ip`, `x-forwarded`, `x-forwarded-host`,
`originating-ip`, `x-custom-ip`.

That stripping **is** the product. Forwarding a client's `x-forwarded-for` would hand the
upstream a direct map to the origin and defeat egress masking entirely.

`authorization` and `content-type` are deliberately **not** stripped — they must reach the
provider.

---

## Response markers

| Header                           | Meaning                                         |
| -------------------------------- | ----------------------------------------------- |
| `X-CyberStream-Relay: true`      | The response came through a relay hop           |
| `X-CyberStream-Region: <region>` | Deployment region, when the runtime exposes one |

Both are diagnostic. The proxy's relay health scoring attributes faults by _what the hop
answered_, not by headers — see the proxy's `GET /v1/relays`.

The region header is also what makes latency attribution possible: the proxy scores each
(provider, hop) arm separately, so a region that is slow for Gemini can still be the
right choice for OpenCode/Zen.

---

## Development

```bash
npm test        # vitest — routing, header hygiene, streaming, prefixes, import discipline
npm run typecheck
npm run dev:netlify
```

The core is pure Web-standard `Request` → `Response` with no runtime dependencies, so it
behaves identically on every target.

### ⚠️ Relative imports MUST include the `.ts` extension

```ts
import { handleRelayRequest } from '../../core/handler.ts' // ✅
import { handleRelayRequest } from '../../core/handler' // ❌ deploy fails
```

Netlify bundles edge functions through **Deno**, which treats an import specifier as a
literal file path. The extensionless form fails the deploy with:

```
Could not find file: file:///opt/build/repo/core/handler
```

Typecheck will **not** catch this — `allowImportingTsExtensions` permits `.ts` specifiers
but does not require them, and esbuild (Vercel, Netlify standard Functions) resolves the
bare form happily. `core/imports.test.ts` is the guard: it fails if any relative import
lacks an extension or points at a missing file.

---

## Architecture

```
relay/
  core/handler.ts              ← ALL relay behaviour (portable, zero deps)
  core/handler.test.ts         ← routing, header hygiene, streaming
  core/imports.test.ts         ← extension discipline (deploy guard)
  api/index.ts                 ← Vercel Edge adapter
  cloudflare/index.ts          ← Cloudflare Workers adapter (workerd)
  cloudflare/index.test.ts     ← Cloudflare Workers tests
  netlify/edge-functions/      ← Netlify Edge Functions adapter (Deno)
  netlify/functions/           ← Netlify standard Functions adapter (Lambda)
  wrangler.jsonc               ← Cloudflare Workers configuration
  netlify.toml
  vercel.json
```

The core has no runtime dependencies and no platform imports, so the same code path
serves every target. Duplicating the routing table per platform is how paths drift and a
fix lands on one host only.
