import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ChangelogId, PostTagId } from '@quackback/ids'
import { ValidationError } from '@/lib/shared/errors'

const mockPostTagsFindMany = vi.fn()
const mockTxDeleteWhere = vi.fn()
const mockTxInsertValues = vi.fn()

vi.mock('@/lib/server/db', async (importOriginal) => ({
  // Spread the real db module so tables/operators stay current; override only what this suite drives.
  ...(await importOriginal<typeof import('@/lib/server/db')>()),
  db: {
    query: {
      postTags: {
        findMany: (...args: unknown[]) => mockPostTagsFindMany(...args),
      },
    },
    transaction: async (cb: (tx: unknown) => Promise<void>) => {
      const tx = {
        delete: () => ({
          where: (...args: unknown[]) => mockTxDeleteWhere(...args),
        }),
        insert: () => ({
          values: (values: unknown) => mockTxInsertValues(values),
        }),
      }
      return cb(tx)
    },
  },
  eq: vi.fn(),
  and: vi.fn(),
  isNull: vi.fn(),
  inArray: vi.fn(),
}))

vi.mock('@/lib/server/content/rehost-images', () => ({
  rehostExternalImages: vi.fn(async (json: unknown) => json),
}))
vi.mock('@/lib/server/events/dispatch', () => ({
  buildEventActor: vi.fn(() => ({ type: 'user' })),
  dispatchChangelogPublished: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/server/events/scheduler', () => ({
  scheduleDispatch: vi.fn(),
  cancelScheduledDispatch: vi.fn(),
}))

const ENTRY_ID = 'changelog_01test' as ChangelogId
const TAG_A = 'post_tag_01existing' as PostTagId
const TAG_B = 'post_tag_01deleted' as PostTagId
const TAG_C = 'post_tag_01unknown' as PostTagId

beforeEach(() => {
  vi.clearAllMocks()
})

describe('setChangelogTags', () => {
  it('replaces the tag set: deletes existing links then inserts the new ones', async () => {
    const { setChangelogTags } = await import('../changelog.service')
    mockPostTagsFindMany.mockResolvedValueOnce([{ id: TAG_A }])

    await setChangelogTags(ENTRY_ID, [TAG_A])

    expect(mockTxDeleteWhere).toHaveBeenCalledTimes(1)
    expect(mockTxInsertValues).toHaveBeenCalledWith([{ changelogEntryId: ENTRY_ID, tagId: TAG_A }])
  })

  it('clears all tags when given an empty array, without inserting', async () => {
    const { setChangelogTags } = await import('../changelog.service')

    await setChangelogTags(ENTRY_ID, [])

    expect(mockPostTagsFindMany).not.toHaveBeenCalled()
    expect(mockTxDeleteWhere).toHaveBeenCalledTimes(1)
    expect(mockTxInsertValues).not.toHaveBeenCalled()
  })

  it('throws ValidationError for an unknown tag id and does not write anything', async () => {
    const { setChangelogTags } = await import('../changelog.service')
    // The unknown id simply never comes back from the (deletedAt-filtered) lookup.
    mockPostTagsFindMany.mockResolvedValueOnce([])

    await expect(setChangelogTags(ENTRY_ID, [TAG_C])).rejects.toBeInstanceOf(ValidationError)
    expect(mockTxDeleteWhere).not.toHaveBeenCalled()
    expect(mockTxInsertValues).not.toHaveBeenCalled()
  })

  it('throws ValidationError for a soft-deleted tag id and does not write anything', async () => {
    const { setChangelogTags } = await import('../changelog.service')
    // The lookup filters isNull(deletedAt), so a soft-deleted tag id also
    // never comes back — same tolerant-lookup shape as the unknown-id case.
    mockPostTagsFindMany.mockResolvedValueOnce([])

    await expect(setChangelogTags(ENTRY_ID, [TAG_B])).rejects.toBeInstanceOf(ValidationError)
    expect(mockTxDeleteWhere).not.toHaveBeenCalled()
    expect(mockTxInsertValues).not.toHaveBeenCalled()
  })

  it('rejects the whole batch when only some tag ids are valid', async () => {
    const { setChangelogTags } = await import('../changelog.service')
    mockPostTagsFindMany.mockResolvedValueOnce([{ id: TAG_A }])

    await expect(setChangelogTags(ENTRY_ID, [TAG_A, TAG_C])).rejects.toBeInstanceOf(ValidationError)
    expect(mockTxDeleteWhere).not.toHaveBeenCalled()
  })
})
