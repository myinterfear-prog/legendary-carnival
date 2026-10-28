/**
 * CyberStream Relay — Netlify standard Functions adapter (Node / Lambda).
 *
 * ⚠️  READ THE LIMIT BEFORE USING THIS TARGET.
 *
 * Netlify standard Functions impose a **60-second synchronous execution limit
 * that CANNOT be configured**, plus a 20 MB cap on streamed responses. This
 * proxy's budget is 32 minutes and long thinking-model responses routinely
 * stream past 60 s, so requests that exceed the cap are killed by the platform
 * and returned to the client as a gateway error.
 *
 * That failure is indistinguishable from a broken relay to the client, AND the
 * proxy's health tracker would correctly charge it to this hop — draining a
 * perfectly healthy deployment out of the pool. Use this target ONLY for
 * workloads you know complete inside 60 s (model catalog fetches, short
 * non-thinking completions), or deploy the Edge Functions variant at the same
 * path instead.
 *
 * All relay behaviour lives in `core/handler.ts`.
 */

import type { Config, Context } from '@netlify/functions'
// The `.ts` extension is REQUIRED for consistency with the edge-function
// adapter and for Deno-side tooling; the Node bundler tolerates both forms.
import { handleRelayRequest } from '../../core/handler.ts'

export default async function relay(req: Request, context: Context): Promise<Response> {
  return handleRelayRequest(req)
}

export const config: Config = {
  path: '/apix/*'
}
