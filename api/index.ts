/**
 * CyberStream Relay — Vercel Edge adapter.
 *
 * All relay behaviour lives in `core/handler.ts`; this file only satisfies
 * Vercel's entry-point contract. `vercel.json` rewrites every path here.
 */

// The `.ts` extension is REQUIRED, not stylistic. Netlify's edge bundler
// resolves through Deno, which follows the ESM rule that a specifier names a
// real file — `../core/handler` fails with "Could not find file". esbuild
// (Vercel) tolerates the bare form, so dropping the extension looks fine
// everywhere except the one runtime that matters.
import { handleRelayRequest } from '../core/handler.ts'

export const config = {
  runtime: 'edge',
  maxDuration: 300
}

export default function handler(req: Request): Promise<Response> {
  return handleRelayRequest(req)
}
