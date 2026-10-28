import { defineConfig } from 'vitest/config'

/**
 * Relay is a STANDALONE npm project (not a Bun workspace member — see the root
 * AGENTS.md). It needs its own Vitest config because running `vitest` here
 * would otherwise discover the monorepo root config, whose `include` globs
 * only cover `apps/proxy` and `packages/*` and would silently find zero files.
 */
export default defineConfig({
  test: {
    include: ['core/**/*.test.ts', 'cloudflare/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node'
  }
})
