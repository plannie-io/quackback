import { describe, it, expect, vi, beforeEach } from 'vitest'
import { sql } from 'drizzle-orm'

const mockSelectDistinct = vi.fn()
const mockFrom = vi.fn()
const mockInnerJoin = vi.fn()
const mockWhere = vi.fn()

// The subquery chain (`db.selectDistinct().from().innerJoin().where()`) only
// needs to satisfy drizzle's SQLWrapper shape (a `getSQL()` method) to be
// embeddable inside `inArray(...)` — this suite verifies the condition is
// built correctly, not that it round-trips against a real database (that's
// what the migration smoke test / integration coverage is for).
vi.mock('@/lib/server/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/db')>()),
  db: {
    selectDistinct: (...args: unknown[]) => mockSelectDistinct(...args),
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
  mockWhere.mockReturnValue({ getSQL: () => sql`SELECT 1` })
  mockInnerJoin.mockReturnValue({ where: mockWhere })
  mockFrom.mockReturnValue({ innerJoin: mockInnerJoin })
  mockSelectDistinct.mockReturnValue({ from: mockFrom })
})

describe('tagFilterCondition', () => {
  it('returns undefined when neither tagIds nor tags is given', async () => {
    const { tagFilterCondition } = await import('../changelog-tag.service')
    expect(tagFilterCondition({})).toBeUndefined()
    expect(tagFilterCondition({ tagIds: [], tags: [] })).toBeUndefined()
    expect(mockSelectDistinct).not.toHaveBeenCalled()
  })

  it('builds an IN-subquery condition when tagIds is given', async () => {
    const { tagFilterCondition } = await import('../changelog-tag.service')
    const condition = tagFilterCondition({ tagIds: ['post_tag_01a' as never] })

    expect(condition).toBeDefined()
    expect(mockSelectDistinct).toHaveBeenCalledTimes(1)
    expect(mockWhere).toHaveBeenCalledTimes(1)
  })

  it('builds a condition when only tag names are given', async () => {
    const { tagFilterCondition } = await import('../changelog-tag.service')
    const condition = tagFilterCondition({ tags: ['App'] })

    expect(condition).toBeDefined()
    expect(mockSelectDistinct).toHaveBeenCalledTimes(1)
  })

  it('trims and lowercases tag names before matching, dropping blanks', async () => {
    const { tagFilterCondition } = await import('../changelog-tag.service')
    tagFilterCondition({ tags: ['  App  ', '', '   '] })

    // The where() call receives the composed AND(OR(...), isNull(...))
    // condition; rendering it to SQL text lets us assert the normalized
    // value made it through without depending on drizzle's internal shape.
    // A plain JSON.stringify can't walk this — drizzle's PgColumn objects
    // point back at their owning PgTable (`column.table`), so the replacer
    // below drops that one property to break the cycle.
    const whereArg = mockWhere.mock.calls[0]![0]
    const rendered = JSON.stringify(whereArg, (key, value) => (key === 'table' ? undefined : value))
    expect(rendered).toContain('app')
    expect(rendered).not.toContain('App')
  })

  it('combines an id filter and a name filter with OR', async () => {
    const { tagFilterCondition } = await import('../changelog-tag.service')
    tagFilterCondition({ tagIds: ['post_tag_01a' as never], tags: ['App'] })

    expect(mockWhere).toHaveBeenCalledTimes(1)
  })
})
