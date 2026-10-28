/**
 * CyberStream Relay — Netlify Edge Functions adapter (Deno runtime).
 *
 * RECOMMENDED NETLIFY TARGET.
 *
 * Why this and not Netlify standard Functions: this proxy's request budget is
 * 32 minutes (`REQUEST_TIMEOUT_MS`), and thinking models stream for minutes.
 * Netlify standard Functions impose a **60-second synchronous execution cap
 * that cannot be configured**; Netlify Edge Functions impose only a 40-second
 * response-HEADER timeout, and only count 50 ms of CPU per request (waiting on
 * the upstream is excluded). Headers arrive from the provider immediately, so
 * long streams survive here and die on Lambda.
 *
 * All relay behaviour lives in `core/handler.ts`.
 */

import type { Config, Context } from '@netlify/edge-functions'
// The `.ts` extension is REQUIRED, not stylistic. Netlify bundles edge
// functions through Deno, which follows the ESM rule that a specifier names a
// real file. The extensionless form fails the build with
// "Could not find file: .../core/handler" — and esbuild-based targets accept
// it, so the omission only ever shows up on Netlify.
import { handleRelayRequest } from '../../core/handler.ts'

export default async function relay(req: Request, context: Context): Promise<Response> {
  return handleRelayRequest(req, { region: context.server?.region })
}

export const config: Config = {
  path: '/api/*'
}
