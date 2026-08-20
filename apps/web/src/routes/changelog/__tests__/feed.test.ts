import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ChangelogId } from '@quackback/ids'

const mockSelectLimit = vi.fn()
const mockTagFilterCondition = vi.fn()
const mockGetTagsForEntries = vi.fn()

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: vi.fn(() => (opts: unknown) => ({ options: opts })),
}))

vi.mock('@/lib/server/config', () => ({
  config: { baseUrl: 'https://t.example' },
}))

vi.mock('@/lib/server/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/db')>()),
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: (...args: unknown[]) => mockSelectLimit(...args),
          }),
        }),
      }),
    }),
  },
}))

vi.mock('@/lib/server/domains/changelog/changelog.public', () => ({
  publicChangelogConditions: vi.fn(() => []),
}))

vi.mock('@/lib/server/settings-utils', () => ({
  getSettingsBrandingData: vi.fn(async () => ({ name: 'Acme' })),
}))

vi.mock('@/lib/server/functions/portal-access', () => ({
  resolvePortalAccessForRequest: vi.fn(async () => ({ granted: true })),
}))

vi.mock('@/lib/server/domains/changelog/changelog.audience', () => ({
  isChangelogAudienceGranted: vi.fn(async () => true),
}))

vi.mock('@/lib/server/functions/auth-helpers', () => ({
  getOptionalAuth: vi.fn(async () => null),
  policyActorFromAuth: vi.fn(async () => ({ type: 'anonymous' })),
}))

vi.mock('@/lib/server/domains/settings/settings.service', () => ({
  isFeatureEnabled: vi.fn(async () => true),
}))

vi.mock('@/lib/server/domains/changelog/changelog-tag.service', () => ({
  tagFilterCondition: (...args: unknown[]) => mockTagFilterCondition(...args),
  getTagsForEntries: (...args: unknown[]) => mockGetTagsForEntries(...args),
}))

import { Route } from '../feed'

type Handlers = { GET: (args: { request: Request }) => Promise<Response> }
type RouteOpts = { server: { handlers: Handlers } }
const { GET } = (Route as unknown as { options: RouteOpts }).options.server.handlers

const ENTRY_A = 'changelog_01a' as unknown as ChangelogId
const ENTRY_B = 'changelog_01b' as unknown as ChangelogId

function entryRow(id: ChangelogId, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `Entry ${id}`,
    content: 'Body text',
    publishedAt: new Date('2026-01-01T00:00:00.000Z'),
    displayDate: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockTagFilterCondition.mockReturnValue(undefined)
  mockGetTagsForEntries.mockResolvedValue(new Map())
  mockSelectLimit.mockResolvedValue([entryRow(ENTRY_A), entryRow(ENTRY_B)])
})

describe('GET /changelog/feed — tags', () => {
  it('emits one <category> element per tag on entries that have tags', async () => {
    mockGetTagsForEntries.mockResolvedValue(
      new Map([
        [ENTRY_A, [{ id: 'post_tag_1', name: 'App', color: '#111' }]],
        [
          ENTRY_B,
          [
            { id: 'post_tag_1', name: 'App', color: '#111' },
            { id: 'post_tag_2', name: 'Blog', color: '#222' },
          ],
        ],
      ])
    )

    const res = await GET({ request: new Request('https://t.example/changelog/feed') })
    expect(res.status).toBe(200)
    const xml = await res.text()

    const categoryMatches = xml.match(/<category>[^<]*<\/category>/g) ?? []
    expect(categoryMatches).toEqual([
      '<category>App</category>',
      '<category>App</category>',
      '<category>Blog</category>',
    ])
  })

  it('emits no <category> elements for an entry with no tags', async () => {
    mockGetTagsForEntries.mockResolvedValue(new Map())

    const res = await GET({ request: new Request('https://t.example/changelog/feed') })
    const xml = await res.text()

    expect(xml).not.toContain('<category>')
  })

  it('parses a single ?tag= into a name filter passed to tagFilterCondition', async () => {
    await GET({ request: new Request('https://t.example/changelog/feed?tag=App') })

    expect(mockTagFilterCondition).toHaveBeenCalledWith({ tags: ['App'] })
  })

  it('parses comma-separated ?tag= values into multiple names', async () => {
    await GET({ request: new Request('https://t.example/changelog/feed?tag=App,Blog') })

    expect(mockTagFilterCondition).toHaveBeenCalledWith({ tags: ['App', 'Blog'] })
  })

  it('parses repeated ?tag= params into multiple names', async () => {
    await GET({ request: new Request('https://t.example/changelog/feed?tag=App&tag=Blog') })

    expect(mockTagFilterCondition).toHaveBeenCalledWith({ tags: ['App', 'Blog'] })
  })

  it('does not call tagFilterCondition when no ?tag= is given', async () => {
    await GET({ request: new Request('https://t.example/changelog/feed') })

    expect(mockTagFilterCondition).not.toHaveBeenCalled()
  })

  it('still applies the access-guard: an empty feed when portal access is denied', async () => {
    const portalAccess = await import('@/lib/server/functions/portal-access')
    vi.mocked(portalAccess.resolvePortalAccessForRequest).mockResolvedValueOnce({
      granted: false,
    } as never)

    const res = await GET({
      request: new Request('https://t.example/changelog/feed?tag=App'),
    })
    const xml = await res.text()

    expect(xml).not.toContain('<item>')
    expect(mockSelectLimit).not.toHaveBeenCalled()
  })
})
