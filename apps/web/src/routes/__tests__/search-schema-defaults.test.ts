/**
 * Crawlability guard: no *crawlable* route's `validateSearch` schema may carry a
 * default.
 *
 * TanStack Router treats `validateSearch` as canonicalising — when the parsed
 * search object contains a key the request URL did not, the router redirects to
 * the URL that does. A `.default()` in the schema therefore turns every
 * parameter-free URL for that route into a permanent redirect to a
 * parameterised copy of itself.
 *
 * That is not a cosmetic problem for the public portal. `/` is the URL listed in
 * sitemap.xml and the target of the `rel=canonical` the index route emits, so a
 * `.default('trending')` on `sort` made the portal home page a 307 to
 * `/?sort=trending` — a declared canonical that does not resolve. Google files
 * the parameterised URLs under "Alternative page with proper canonical tag" and
 * then fails validation on them, and the home page itself lands in "Page with
 * redirect". Observed live on feedback.plannie.io before this was removed.
 *
 * Defaults belong at the point of use (`search.sort ?? 'trending'`), where they
 * cost nothing. This test scans source rather than importing the routes because
 * importing a route module pulls in its whole component tree, and because the
 * invariant is about what the file *says* — a default is a mistake even in a
 * route nobody has rendered yet.
 *
 * `routes/admin/` is exempt, and deliberately so: robots.txt disallows /admin/
 * and every admin route is auth-gated, so nothing there is ever crawled and a
 * canonicalising rewrite is a UX choice rather than an indexing bug. This guard
 * is about the public surface.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROUTES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      return entry === '__tests__' ? [] : routeFiles(full)
    }
    return /\.tsx?$/.test(entry) ? [full] : []
  })
}

/** Comments describing this rule mention `.default(` — don't match on prose. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/**
 * The schema a route hands to `validateSearch` is usually a `const` declared
 * above the route, so the check is deliberately broad: any `z.object({...})` in
 * a file that calls `validateSearch`. Over-reaching here is the safe direction —
 * a `.default()` in a search schema is the only thing this can catch, and a
 * false positive is a one-line fix at the call site.
 */
function schemaBlocks(source: string): string[] {
  const blocks: string[] = []
  for (const match of source.matchAll(/z\.object\(\{/g)) {
    const start = match.index + match[0].length - 1
    let depth = 0
    for (let i = start; i < source.length; i++) {
      if (source[i] === '{') depth++
      else if (source[i] === '}') {
        depth--
        if (depth === 0) {
          blocks.push(source.slice(start, i + 1))
          break
        }
      }
    }
  }
  return blocks
}

const ADMIN_DIR = join(ROUTES_DIR, 'admin')

describe('crawlable route search schemas', () => {
  const files = routeFiles(ROUTES_DIR)
    .filter((f) => !f.startsWith(`${ADMIN_DIR}/`))
    .filter((f) => stripComments(readFileSync(f, 'utf8')).includes('validateSearch'))

  it('finds crawlable route files that validate search params', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it.each(files)('%s declares no default() in its search schema', (file) => {
    const offenders = schemaBlocks(stripComments(readFileSync(file, 'utf8'))).filter((block) =>
      block.includes('.default(')
    )
    expect(
      offenders,
      `${file}: a default in validateSearch makes the parameter-free URL redirect ` +
        `to the parameterised one, which breaks the canonical. Apply the fallback ` +
        `where the value is read instead.`
    ).toEqual([])
  })
})
