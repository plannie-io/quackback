import { createFileRoute } from '@tanstack/react-router'
import { stripHtml, truncate } from '@/lib/shared/utils'

export const Route = createFileRoute('/changelog/feed')({
  server: {
    handlers: {
      /**
       * GET /changelog/feed
       * Returns RSS 2.0 feed of published changelog entries. Accepts an
       * optional `?tag=` filter (repeatable or comma-separated tag names,
       * matched case-insensitively) — the surface Plannie's own backend
       * consumes to show only "app"-tagged entries in the mobile bell.
       */
      GET: async ({ request }) => {
        const [
          { config },
          { db, changelogEntries, and, desc, sql },
          { publicChangelogConditions },
          { getSettingsBrandingData },
          { resolvePortalAccessForRequest },
          { isChangelogAudienceGranted },
          { getOptionalAuth, policyActorFromAuth },
          { isFeatureEnabled },
          { tagFilterCondition, getTagsForEntries },
        ] = await Promise.all([
          import('@/lib/server/config'),
          import('@/lib/server/db'),
          import('@/lib/server/domains/changelog/changelog.public'),
          import('@/lib/server/settings-utils'),
          import('@/lib/server/functions/portal-access'),
          import('@/lib/server/domains/changelog/changelog.audience'),
          import('@/lib/server/functions/auth-helpers'),
          import('@/lib/server/domains/settings/settings.service'),
          import('@/lib/server/domains/changelog/changelog-tag.service'),
        ])

        // `?tag=` accepts either repeated params (`?tag=app&tag=blog`) or a
        // single comma-separated value (`?tag=app,blog`); names are matched
        // case-insensitively by tagFilterCondition.
        const url = new URL(request.url)
        const tagParams = url.searchParams.getAll('tag')
        const tags = tagParams
          .flatMap((t) => t.split(','))
          .map((t) => t.trim())
          .filter(Boolean)
        const tagCondition = tags.length > 0 ? tagFilterCondition({ tags }) : undefined

        const effectiveDisplayDate = sql<Date>`coalesce(${changelogEntries.displayDate}, ${changelogEntries.publishedAt})`

        const baseUrl = config.baseUrl

        // Get workspace branding for feed title
        const branding = await getSettingsBrandingData()
        const siteName = branding?.name || 'Changelog'

        // Private portals must not expose changelog content via the RSS feed.
        // Mirror sitemap.xml: a denied caller gets a valid but empty feed.
        const access = await resolvePortalAccessForRequest()

        // Changelog audience gate (Settings > Changelog > Visibility):
        // 'authenticated' hides the feed from anonymous fetchers too.
        const actor = access.granted ? await policyActorFromAuth(await getOptionalAuth()) : null
        const audienceGranted = actor ? await isChangelogAudienceGranted(actor) : false

        const productEnabled = await isFeatureEnabled('changelog')
        const feedConditions = [
          ...publicChangelogConditions(new Date()),
          ...(tagCondition ? [tagCondition] : []),
        ]
        const entries =
          productEnabled && access.granted && audienceGranted
            ? await db
                .select()
                .from(changelogEntries)
                .where(and(...feedConditions))
                .orderBy(desc(effectiveDisplayDate))
                .limit(50)
            : []

        // Batched tag hydration for the (at most ~50) selected entries — one
        // `<category>` element per tag inside each RSS `<item>`.
        const tagsByEntry = await getTagsForEntries(entries.map((e) => e.id))

        // Per-caller portal-access decisions can't share a public CDN
        // cache: a granted caller would seed the cache with content that
        // every subsequent denied caller would then receive. Use
        // `private` to keep the response per-browser, and `Vary: Cookie`
        // so any cookie-aware intermediary keys correctly. Public
        // portals match `granted=true` for everyone, so the practical
        // cost (no shared CDN cache) is small — and the alternative is
        // a real data leak.
        const cacheControl = 'private, max-age=300'

        // Build RSS XML
        const rssXml = buildRssFeed({
          title: `${siteName} Changelog`,
          description: `Latest updates and releases from ${siteName}`,
          link: `${baseUrl}/changelog`,
          feedUrl: `${baseUrl}/changelog/feed`,
          entries: entries.map((entry) => ({
            id: entry.id,
            title: entry.title,
            content: entry.content,
            publishedAt: entry.displayDate ?? entry.publishedAt!,
            link: `${baseUrl}/changelog/${entry.id}`,
            tags: (tagsByEntry.get(entry.id) ?? []).map((t) => t.name),
          })),
        })

        return new Response(rssXml, {
          headers: {
            'Content-Type': 'application/rss+xml; charset=utf-8',
            'Cache-Control': cacheControl,
            Vary: 'Cookie',
          },
        })
      },
    },
  },
})

interface RssFeedOptions {
  title: string
  description: string
  link: string
  feedUrl: string
  entries: Array<{
    id: string
    title: string
    content: string
    publishedAt: Date
    link: string
    tags: string[]
  }>
}

function buildRssFeed(options: RssFeedOptions): string {
  const { title, description, link, feedUrl, entries } = options

  const escapeXml = (str: string): string => {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
  }

  const formatRfc822Date = (date: Date): string => {
    return date.toUTCString()
  }

  const items = entries
    .map((entry) => {
      // Strip HTML for description, keep it short
      const truncatedContent = truncate(stripHtml(entry.content), 500)
      const categories = entry.tags
        .map((tag) => `      <category>${escapeXml(tag)}</category>`)
        .join('\n')

      return `    <item>
      <title>${escapeXml(entry.title)}</title>
      <link>${escapeXml(entry.link)}</link>
      <guid isPermaLink="true">${escapeXml(entry.link)}</guid>
      <description>${escapeXml(truncatedContent)}</description>
      <pubDate>${formatRfc822Date(entry.publishedAt)}</pubDate>
${categories ? categories + '\n' : ''}    </item>`
    })
    .join('\n')

  const lastBuildDate =
    entries.length > 0 ? formatRfc822Date(entries[0].publishedAt) : formatRfc822Date(new Date())

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(title)}</title>
    <description>${escapeXml(description)}</description>
    <link>${escapeXml(link)}</link>
    <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml"/>
    <lastBuildDate>${lastBuildDate}</lastBuildDate>
    <language>en-us</language>
${items}
  </channel>
</rss>`
}
