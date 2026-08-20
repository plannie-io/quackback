import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockWithApiKeyAuth = vi.fn()
const mockCreateChangelog = vi.fn()
const mockListChangelogs = vi.fn()
const mockPrincipalFindFirst = vi.fn()

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: vi.fn(() => (opts: unknown) => ({ options: opts })),
}))
vi.mock('@/lib/server/domains/api/auth', () => ({
  withApiKeyAuth: (...args: unknown[]) => mockWithApiKeyAuth(...args),
}))
vi.mock('@/lib/server/domains/changelog/changelog.service', () => ({
  createChangelog: (...args: unknown[]) => mockCreateChangelog(...args),
}))
vi.mock('@/lib/server/domains/changelog/changelog.query', () => ({
  listChangelogs: (...args: unknown[]) => mockListChangelogs(...args),
}))
vi.mock('@/lib/server/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/db')>()),
  db: {
    query: {
      principal: { findFirst: (...args: unknown[]) => mockPrincipalFindFirst(...args) },
    },
  },
  eq: vi.fn(),
}))

import { Route } from '../index'

type Handlers = {
  GET: (args: { request: Request }) => Promise<Response>
  POST: (args: { request: Request }) => Promise<Response>
}
type RouteOpts = { server: { handlers: Handlers } }
const { GET, POST } = (Route as unknown as { options: RouteOpts }).options.server.handlers

const ENTRY_ID = 'changelog_01h455vb4pex5vsknk084sn02q'
const POST_A = 'post_01h455vb4pex5vsknk084sn02q'
const TAG_A = 'post_tag_01h455vb4pex5vsknk084sn02q'

const LINKED_POST = {
  id: POST_A,
  title: 'Dark mode request',
  voteCount: 4,
  status: { name: 'Shipped', color: '#22c55e' },
}

const TAG = { id: TAG_A, name: 'App', color: '#6b7280' }

function entry(overrides: Record<string, unknown> = {}) {
  return {
    id: ENTRY_ID,
    title: 'Dark mode',
    content: 'We shipped dark mode.',
    contentJson: null,
    publishedAt: new Date('2026-01-01T00:00:00.000Z'),
    displayDate: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    linkedPosts: [LINKED_POST],
    tags: [TAG],
    ...overrides,
  }
}

function postRequest(body: Record<string, unknown>): Request {
  return new Request('http://t/api/v1/changelog', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockWithApiKeyAuth.mockResolvedValue({ principalId: 'principal_x', role: 'team' })
  mockPrincipalFindFirst.mockResolvedValue({ displayName: 'API' })
  mockCreateChangelog.mockResolvedValue(entry())
  mockListChangelogs.mockResolvedValue({
    items: [entry()],
    nextCursor: null,
    hasMore: false,
  })
})

describe('GET /api/v1/changelog — linked posts', () => {
  it('includes linked posts on each listed entry', async () => {
    const res = await GET({ request: new Request('http://t/api/v1/changelog') })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data).toHaveLength(1)
    expect(json.data[0].linkedPosts).toEqual([LINKED_POST])
  })

  it('returns an empty linkedPosts array when the entry has none', async () => {
    mockListChangelogs.mockResolvedValue({
      items: [entry({ linkedPosts: [] })],
      nextCursor: null,
      hasMore: false,
    })

    const res = await GET({ request: new Request('http://t/api/v1/changelog') })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data[0].linkedPosts).toEqual([])
  })
})

describe('POST /api/v1/changelog — linked posts', () => {
  it('forwards linkedPostIds to createChangelog and echoes linked posts', async () => {
    const res = await POST({
      request: postRequest({
        title: 'Dark mode',
        content: 'We shipped dark mode.',
        linkedPostIds: [POST_A],
      }),
    })

    expect(res.status).toBe(201)
    expect(mockCreateChangelog).toHaveBeenCalledTimes(1)
    expect(mockCreateChangelog.mock.calls[0][0]).toMatchObject({
      title: 'Dark mode',
      linkedPostIds: [POST_A],
    })
    const json = await res.json()
    expect(json.data.linkedPosts).toEqual([LINKED_POST])
  })

  it('rejects a malformed linkedPostId without calling createChangelog', async () => {
    const res = await POST({
      request: postRequest({
        title: 'Dark mode',
        content: 'We shipped dark mode.',
        linkedPostIds: ['not-a-post'],
      }),
    })

    expect(res.status).toBe(400)
    expect(mockCreateChangelog).not.toHaveBeenCalled()
  })
})

describe('GET /api/v1/changelog — tags', () => {
  it('includes tags on each listed entry', async () => {
    const res = await GET({ request: new Request('http://t/api/v1/changelog') })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data[0].tags).toEqual([TAG])
  })

  it('returns an empty tags array when the entry has none', async () => {
    mockListChangelogs.mockResolvedValue({
      items: [entry({ tags: [] })],
      nextCursor: null,
      hasMore: false,
    })

    const res = await GET({ request: new Request('http://t/api/v1/changelog') })
    const json = await res.json()
    expect(json.data[0].tags).toEqual([])
  })

  it('parses ?tags= (comma-separated names) and forwards to listChangelogs', async () => {
    const res = await GET({
      request: new Request('http://t/api/v1/changelog?tags=App,Blog'),
    })
    expect(res.status).toBe(200)
    expect(mockListChangelogs).toHaveBeenCalledTimes(1)
    expect(mockListChangelogs.mock.calls[0][0]).toMatchObject({
      tags: ['App', 'Blog'],
    })
  })

  it('parses ?tagIds= (comma-separated typeids) and forwards to listChangelogs', async () => {
    const res = await GET({
      request: new Request(`http://t/api/v1/changelog?tagIds=${TAG_A}`),
    })
    expect(res.status).toBe(200)
    expect(mockListChangelogs.mock.calls[0][0]).toMatchObject({
      tagIds: [TAG_A],
    })
  })

  it('drops malformed tagIds instead of rejecting the request', async () => {
    const res = await GET({
      request: new Request(`http://t/api/v1/changelog?tagIds=not-a-tag,${TAG_A}`),
    })
    expect(res.status).toBe(200)
    expect(mockListChangelogs.mock.calls[0][0]).toMatchObject({
      tagIds: [TAG_A],
    })
  })
})

describe('POST /api/v1/changelog — tags', () => {
  it('forwards tagIds to createChangelog and echoes tags', async () => {
    const res = await POST({
      request: postRequest({
        title: 'Dark mode',
        content: 'We shipped dark mode.',
        tagIds: [TAG_A],
      }),
    })

    expect(res.status).toBe(201)
    expect(mockCreateChangelog.mock.calls[0][0]).toMatchObject({
      title: 'Dark mode',
      tagIds: [TAG_A],
    })
    const json = await res.json()
    expect(json.data.tags).toEqual([TAG])
  })

  it('rejects a malformed tagId without calling createChangelog', async () => {
    const res = await POST({
      request: postRequest({
        title: 'Dark mode',
        content: 'We shipped dark mode.',
        tagIds: ['not-a-tag'],
      }),
    })

    expect(res.status).toBe(400)
    expect(mockCreateChangelog).not.toHaveBeenCalled()
  })
})
