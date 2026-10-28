/**
 * Import-specifier discipline.
 *
 * A relative import in this project must name a real file, extension
 * included. This is not stylistic: Netlify bundles edge functions through
 * Deno, which follows the ESM rule that a specifier is a literal path.
 *
 *   import { handleRelayRequest } from '../../core/handler'
 *   → Error: Could not find file: file:///opt/build/repo/core/handler
 *
 * The failure only appears on Netlify's edge runtime. esbuild — behind both
 * Vercel and Netlify standard Functions — happily resolves the bare form and
 * inlines the extension, so typecheck passes and local builds pass. The
 * omission is invisible until the deploy, which is the worst place to find it.
 *
 * TypeScript cannot guard this either: `allowImportingTsExtensions` permits
 * `.ts` specifiers but does not REQUIRE them, so both forms compile. This
 * test is the only thing standing between a refactor and a red build.
 */

import { describe, test, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'

const ROOT = resolve(__dirname, '..')
const SOURCE_DIRS = ['api', 'core', 'netlify', 'cloudflare']

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...walk(full))
    } else if (full.endsWith('.ts')) {
      out.push(full)
    }
  }
  return out
}

/** Relative import specifiers, from both `import` and `export ... from`. */
function relativeImports(source: string): string[] {
  const specifiers: string[] = []
  const pattern = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"](\.[^'"]+)['"]/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source)) !== null) {
    specifiers.push(match[1]!)
  }
  return specifiers
}

describe('relative imports carry an explicit extension', () => {
  const files = SOURCE_DIRS.flatMap(d => walk(join(ROOT, d)))

  test('the scan actually found the relay sources', () => {
    // Guards against this file silently passing on an empty glob.
    expect(files.length).toBeGreaterThan(4)
  })

  for (const file of files) {
    const rel = file.slice(ROOT.length + 1)
    test(`${rel} uses extension-qualified specifiers`, () => {
      const source = readFileSync(file, 'utf8')
      for (const specifier of relativeImports(source)) {
        expect(
          specifier.endsWith('.ts'),
          `${rel} imports '${specifier}' without a file extension. Netlify's edge ` +
            `bundler runs on Deno, which resolves specifiers as literal paths and ` +
            `fails the deploy with "Could not find file". Use '${specifier}.ts'.`
        ).toBe(true)
      }
    })
  }

  test('every relative specifier resolves to a file that exists', () => {
    // Catches a renamed core module that still typechecks via stale output.
    for (const file of files) {
      for (const specifier of relativeImports(readFileSync(file, 'utf8'))) {
        const target = resolve(dirname(file), specifier)
        expect(
          statSync(target).isFile(),
          `${file.slice(ROOT.length + 1)} imports '${specifier}', which does not exist`
        ).toBe(true)
      }
    }
  })
})
