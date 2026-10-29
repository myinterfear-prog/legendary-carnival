/**
 * Deno needs literal .ts paths, while Vercel preserves import specifiers in
 * emitted JavaScript and needs .js paths. Typechecking accepts both, so it
 * cannot catch a specifier that works locally but fails during deployment.
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
    test(`${rel} uses runtime-compatible extension-qualified specifiers`, () => {
      const source = readFileSync(file, 'utf8')
      const extension = rel === 'api/index.ts' ? '.js' : '.ts'
      for (const specifier of relativeImports(source)) {
        expect(
          specifier.endsWith(extension),
          `${rel} imports '${specifier}' but requires a ${extension} extension. ` +
            'Vercel needs emitted .js paths; Deno needs literal .ts source paths.'
        ).toBe(true)
      }
    })
  }

  test('every relative specifier resolves to a file that exists', () => {
    // Catches a renamed core module that still typechecks via stale output.
    for (const file of files) {
      for (const specifier of relativeImports(readFileSync(file, 'utf8'))) {
        const sourceSpecifier = file === join(ROOT, 'api/index.ts')
          ? specifier.replace(/\.js$/, '.ts')
          : specifier
        const target = resolve(dirname(file), sourceSpecifier)
        expect(
          statSync(target).isFile(),
          `${file.slice(ROOT.length + 1)} imports '${specifier}', which does not exist`
        ).toBe(true)
      }
    }
  })
})
