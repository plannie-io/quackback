/**
 * getS3Object (the S3_PROXY read path) must fetch bytes through a presigned
 * URL with the runtime's native `fetch`, never through the SDK's
 * `GetObjectCommand` body stream: on Bun that stream rides `node:https`,
 * whose compat layer can stop emitting data after enough requests
 * (oven-sh/bun#27557) and leaves every later proxied read hanging.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const mockConfig = {
  s3Bucket: 'my-bucket',
  s3Region: 'eu-north-1',
  s3AccessKeyId: 'access-key',
  s3SecretAccessKey: 'secret-key',
  s3Endpoint: undefined as string | undefined,
  s3ForcePathStyle: false,
  s3PublicUrl: undefined as string | undefined,
  s3Proxy: true,
  baseUrl: 'https://app.example.com',
}

vi.mock('@/lib/server/config', () => ({ config: mockConfig }))

const mockSend = vi.fn(async () => ({}))

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(function () {
    return { send: mockSend, destroy: vi.fn() }
  }),
  PutObjectCommand: vi.fn(function (input: unknown) {
    return { input }
  }),
  GetObjectCommand: vi.fn(function (input: unknown) {
    return { input }
  }),
  DeleteObjectCommand: vi.fn(function (input: unknown) {
    return { input }
  }),
}))

const mockGetSignedUrl = vi.fn(
  async () => 'https://my-bucket.s3.eu-north-1.amazonaws.com/presigned'
)

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: mockGetSignedUrl,
}))

const { getS3Object } = await import('@/lib/server/storage/s3')

const KEY = 'changelog-images/2026/09/abc-rehost-1.jpeg'

afterEach(() => {
  vi.unstubAllGlobals()
  mockSend.mockClear()
  mockGetSignedUrl.mockClear()
})

describe('getS3Object', () => {
  it('presigns the key and reads the bytes with native fetch, not GetObjectCommand', async () => {
    const bytes = new Uint8Array(256 * 1024).fill(7)
    const fetchMock = vi.fn(
      async () => new Response(bytes, { status: 200, headers: { 'content-type': 'image/jpeg' } })
    )
    vi.stubGlobal('fetch', fetchMock)

    const { body, contentType } = await getS3Object(KEY)

    expect(mockGetSignedUrl).toHaveBeenCalledTimes(1)
    const [, command, opts] = mockGetSignedUrl.mock.calls[0] as unknown as [
      unknown,
      { input: { Bucket: string; Key: string } },
      { expiresIn: number },
    ]
    expect(command.input).toEqual({ Bucket: 'my-bucket', Key: KEY })
    expect(opts.expiresIn).toBeGreaterThan(0)
    expect(opts.expiresIn).toBeLessThanOrEqual(600)

    expect(fetchMock).toHaveBeenCalledWith(
      'https://my-bucket.s3.eu-north-1.amazonaws.com/presigned'
    )
    expect(mockSend).not.toHaveBeenCalled()

    expect(contentType).toBe('image/jpeg')
    expect(new Uint8Array(await new Response(body).arrayBuffer())).toEqual(bytes)
  })

  it('falls back to application/octet-stream when S3 sends no content type', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
    )
    const { contentType } = await getS3Object(KEY)
    expect(contentType).toBe('application/octet-stream')
  })

  it('reports a missing object as not found', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<Error/>', { status: 404 }))
    )
    await expect(getS3Object(KEY)).rejects.toThrow(/not found/)
  })

  it('surfaces other S3 errors with the status code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<Error/>', { status: 403 }))
    )
    await expect(getS3Object(KEY)).rejects.toThrow(/HTTP 403/)
  })
})
