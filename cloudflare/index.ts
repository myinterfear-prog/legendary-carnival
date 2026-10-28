/**
 * CyberStream Relay — Cloudflare Workers adapter (workerd runtime).
 *
 * Cloudflare Workers runs on the V8-based workerd runtime across Cloudflare's
 * global anycast edge network (330+ locations). Network I/O and streaming
 * response duration do NOT count against CPU execution limits, making it
 * ideal for long-running thinking-model SSE streams.
 *
 * All relay behaviour lives in `core/handler.ts`.
 */

// The `.ts` extension is REQUIRED for cross-platform import consistency
// and Netlify/Deno compat checks.
import { handleRelayRequest } from '../core/handler.ts'

export interface Env {
  // Environment bindings (none required; relay is zero-auth and stateless)
}

export default {
  async fetch(req: Request, _env?: Env, _ctx?: ExecutionContext): Promise<Response> {
    // Cloudflare edge populates `request.cf` with geo and edge metadata.
    // `colo` contains the 3-letter IATA airport code of the edge PoP (e.g. SFO, LHR, NRT).
    const colo = (req as { cf?: { colo?: string } }).cf?.colo
    return handleRelayRequest(req, {
      region: typeof colo === 'string' && colo.length > 0 ? colo : undefined
    })
  }
}
