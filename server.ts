/**
 * CyberStream Relay — Bun HTTP server adapter for VPS / bare-metal hosts.
 *
 * The relay core (`core/handler.ts`) is pure Web-standard `Request → Response`,
 * so it runs on any runtime that speaks the Fetch API. Bun is the preferred
 * runtime for this repo (see AGENTS.md RULE #05), and `Bun.serve` accepts a
 * fetch handler directly — no framework required.
 *
 * Run:
 *   bun run server.ts            # or: bun server.ts
 *
 * Env:
 *   PORT   (default 8080)       listening port
 *   HOST   (default 0.0.0.0)    bind address
 *   REGION (optional)           deployment region label exposed via X-CyberStream-Region
 *
 * Wire into the proxy:
 *   RELAY_URLS=http://<vps-host>:8080/api
 *   RELAY_PROVIDERS=Gemini/API,OpenCode/Zen
 */
import { handleRelayRequest } from './core/handler.ts'

const port = Number(process.env.PORT ?? 8080)
const hostname = process.env.HOST ?? '0.0.0.0'
const region = process.env.REGION

const server = Bun.serve({
  port,
  hostname,
  idleTimeout: 255,
  async fetch(req: Request): Promise<Response> {
    try {
      return await handleRelayRequest(req, region ? { region } : {})
    } catch (err) {
      console.error('Relay unhandled error:', err)
      return new Response(JSON.stringify({ error: 'relay_internal_error' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      })
    }
  },
})

console.log('CyberStream relay listening on http://' + hostname + ':' + server.port)
if (region) console.log('Region label: ' + region)

const shutdown = (signal: string) => {
  console.log('Received ' + signal + ', shutting down relay...')
  server.stop(true)
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
