/**
 * Changelog tag helpers — filtering and hydration for the entry <-> tag
 * link table. Reuses the workspace's shared `tags` (post_tags) entity (the
 * same one posts use) rather than introducing a separate taxonomy; see
 * `setChangelogTags` in changelog.service.ts for the write side.
 */
import type { SQL } from 'drizzle-orm'
import {
  db,
  eq,
  and,
  or,
  inArray,
  isNull,
  sql,
  changelogEntries,
  changelogEntryTags,
  postTags,
} from '@/lib/server/db'
import type { ChangelogId, PostTagId } from '@quackback/ids'
import type { ChangelogTag } from './changelog.types'

/**
 * Get the tags linked to a set of changelog entries, keyed by entry id.
 * Excludes soft-deleted tags so a deleted tag silently drops off entries
 * that referenced it. Same batched-query, Map-grouping shape the category
 * hydrator (`getCategoriesForEntries`) and the linked-posts readers use.
 */
export async function getTagsForEntries(
  entryIds: ChangelogId[]
): Promise<Map<ChangelogId, ChangelogTag[]>> {
  const map = new Map<ChangelogId, ChangelogTag[]>()
  if (entryIds.length === 0) return map

  const rows = await db
    .select({
      changelogEntryId: changelogEntryTags.changelogEntryId,
      id: postTags.id,
      name: postTags.name,
      color: postTags.color,
    })
    .from(changelogEntryTags)
    .innerJoin(postTags, eq(changelogEntryTags.tagId, postTags.id))
    .where(and(inArray(changelogEntryTags.changelogEntryId, entryIds), isNull(postTags.deletedAt)))
    .orderBy(postTags.name)

  for (const row of rows) {
    const existing = map.get(row.changelogEntryId) ?? []
    existing.push({ id: row.id, name: row.name, color: row.color })
    map.set(row.changelogEntryId, existing)
  }
  return map
}

/**
 * Predicate for filtering changelog entries by tag — matches a tag either by
 * id or by case-insensitive, trimmed name, excluding soft-deleted tags.
 * `IN (subquery)` over a distinct entry-id subquery rather than a join, so
 * callers can drop it straight into their existing `and(...conditions)`
 * list without disturbing `limit + 1` cursor pagination or fanning out
 * duplicate rows for a multi-tagged entry. Mirrors the tagIds filter in
 * post.inbox.ts (`listInboxPosts`), which uses the same
 * `inArray(entity.id, subquery)` shape for the same reason — an
 * `db.query.*.findMany` (relational query builder) caller can't safely
 * correlate a raw `EXISTS` subquery to the outer table (the builder
 * rewrites column references to the outer alias; see the comment on the
 * `responded` filter in post.inbox.ts for the specifics).
 *
 * Returns undefined when neither `tagIds` nor `tags` is provided — callers
 * should skip pushing it into their conditions in that case.
 */
export function tagFilterCondition(params: {
  tagIds?: PostTagId[]
  tags?: string[]
}): SQL<unknown> | undefined {
  const tagIds = (params.tagIds ?? []).filter(Boolean)
  const tagNames = (params.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean)

  if (tagIds.length === 0 && tagNames.length === 0) return undefined

  const matchConditions: SQL<unknown>[] = []
  if (tagIds.length > 0) matchConditions.push(inArray(postTags.id, tagIds))
  if (tagNames.length > 0) {
    matchConditions.push(inArray(sql`lower(trim(${postTags.name}))`, tagNames))
  }

  const entryIdsWithMatchingTags = db
    .selectDistinct({ changelogEntryId: changelogEntryTags.changelogEntryId })
    .from(changelogEntryTags)
    .innerJoin(postTags, eq(changelogEntryTags.tagId, postTags.id))
    .where(and(or(...matchConditions), isNull(postTags.deletedAt)))

  return inArray(changelogEntries.id, entryIdsWithMatchingTags)
}
