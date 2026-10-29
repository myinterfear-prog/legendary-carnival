/**
 * CyberStream Relay — Vercel Edge adapter.
 *
 * All relay behaviour lives in `core/handler.ts`; this file only satisfies
 * Vercel's entry-point contract. `vercel.json` rewrites every path here.
 */

// Vercel preserves this specifier while emitting the core as handler.js.
// TypeScript resolves it to handler.ts during development; Netlify's separate
// Deno adapter must keep its explicit .ts specifier.
import { handleRelayRequest } from '../core/handler.js'

export const config = {
  runtime: 'edge',
  maxDuration: 300
}

export default function handler(req: Request): Promise<Response> {
  return handleRelayRequest(req)
}
