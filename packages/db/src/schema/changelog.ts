import {
  pgTable,
  text,
  timestamp,
  integer,
  index,
  uniqueIndex,
  jsonb,
  foreignKey,
  customType,
} from 'drizzle-orm/pg-core'
import { relations, sql } from 'drizzle-orm'
import { typeIdWithDefault, typeIdColumn, typeIdColumnNullable } from '@quackback/ids/drizzle'
import { principal } from './auth'
import { posts } from './posts'
import type { TiptapContent } from '../types'

/** pgvector column, 1536 dims (OpenAI text-embedding-3-small). Local to this
 *  file, mirroring the per-schema-file `vector` customType convention (see
 *  conversation-summary.ts / posts.ts / kb.ts). Populated on publish/edit by
 *  `changelog-embedding.service.ts` (Quinn Phase 4: changelog grounding);
 *  drafts stay null until they are next published. */
const vector = customType<{ data: number[] }>({
  dataType() {
    return 'vector(1536)'
  },
})

export const changelogEntries = pgTable(
  'changelog_entries',
  {
    id: typeIdWithDefault('changelog')('id').primaryKey(),
    title: text('title').notNull(),
    content: text('content').notNull(),
    // Rich content stored as TipTap JSON (optional, for rich text support)
    contentJson: jsonb('content_json').$type<TiptapContent>(),
    // Author tracking (principal who created/last edited - only shown in admin views)
    principalId: typeIdColumnNullable('principal')('principal_id').references(() => principal.id, {
      onDelete: 'set null',
    }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    displayDate: timestamp('display_date', { withTimezone: true }),
    // Timestamp the publish notification was sent; null until dispatched.
    notifiedAt: timestamp('notified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    // Soft delete support
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    // View count for analytics (incremented on public/widget page load)
    viewCount: integer('view_count').default(0).notNull(),
    // Optional hero image rendered at the top of the public entry detail page.
    featuredImageUrl: text('featured_image_url'),
    // Publish-notification targeting: a non-empty list restricts the
    // subscriber fan-out (email + in-app) to principals holding at least one
    // of these segments. [] = broadcast to every subscriber. Same "segment
    // list, [] = everyone" convention as the segment-gate primitive.
    segmentIds: jsonb('segment_ids').$type<string[]>().notNull().default([]),
    // Semantic embedding for Quinn grounding (Quinn Phase 4). Embedded on
    // publish/edit; drafts stay null. Track the model version so a re-embed
    // can find rows without losing data (mirrors posts.embedding_model).
    embedding: vector('embedding'),
    embeddingModel: text('embedding_model'),
    embeddingUpdatedAt: timestamp('embedding_updated_at', { withTimezone: true }),
  },
  (table) => [
    index('changelog_published_at_idx').on(table.publishedAt),
    index('changelog_principal_id_idx').on(table.principalId),
    index('changelog_deleted_at_idx').on(table.deletedAt),
    index('changelog_embedding_hnsw_idx')
      .using('hnsw', sql`${table.embedding} vector_cosine_ops`)
      .where(sql`${table.embedding} IS NOT NULL`),
  ]
)

// Junction table for linking changelog entries to shipped posts
export const changelogEntryPosts = pgTable(
  'changelog_entry_posts',
  {
    changelogEntryId: typeIdColumn('changelog')('changelog_entry_id').notNull(),
    postId: typeIdColumn('post')('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // Named to match the migration's constraint (63-char pg truncation).
    foreignKey({
      name: 'changelog_entry_posts_changelog_entry_id_changelog_entries_id_f',
      columns: [table.changelogEntryId],
      foreignColumns: [changelogEntries.id],
    }).onDelete('cascade'),
    uniqueIndex('changelog_entry_posts_pk').on(table.changelogEntryId, table.postId),
    index('changelog_entry_posts_post_id_idx').on(table.postId),
  ]
)

// Junction table reusing the workspace's shared `tags` (post_tags) entity to
// filter changelog entries by audience (e.g. "app" vs "blog" vs "internal") —
// no new taxonomy. Shaped like changelogEntryPosts above: same composite
// unique index + per-FK index style, inline `.references()` on both FK
// columns (both auto-generated constraint names are <=63 chars, unlike
// changelogEntryPosts' changelog_entry_id FK which needs the explicit
// truncated name below). `tagId` imported from ./boards after this table's
// own declarations to avoid a circular-import hazard the same way boards.ts
// imports changelogEntries only after its own tables are done.
export const changelogEntryTags = pgTable(
  'changelog_entry_tags',
  {
    changelogEntryId: typeIdColumn('changelog')('changelog_entry_id')
      .notNull()
      .references(() => changelogEntries.id, { onDelete: 'cascade' }),
    tagId: typeIdColumn('post_tag')('tag_id')
      .notNull()
      .references(() => postTags.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('changelog_entry_tags_pk').on(table.changelogEntryId, table.tagId),
    index('changelog_entry_tags_changelog_entry_id_idx').on(table.changelogEntryId),
    index('changelog_entry_tags_tag_id_idx').on(table.tagId),
  ]
)

export const changelogEntriesRelations = relations(changelogEntries, ({ one, many }) => ({
  author: one(principal, {
    fields: [changelogEntries.principalId],
    references: [principal.id],
    relationName: 'changelogAuthor',
  }),
  linkedPosts: many(changelogEntryPosts),
  tags: many(changelogEntryTags),
}))

export const changelogEntryPostsRelations = relations(changelogEntryPosts, ({ one }) => ({
  changelogEntry: one(changelogEntries, {
    fields: [changelogEntryPosts.changelogEntryId],
    references: [changelogEntries.id],
  }),
  post: one(posts, {
    fields: [changelogEntryPosts.postId],
    references: [posts.id],
  }),
}))

// Relations defined after the postTags import to avoid a circular
// dependency, mirroring the convention in boards.ts.
import { postTags } from './boards'

export const changelogEntryTagsRelations = relations(changelogEntryTags, ({ one }) => ({
  changelogEntry: one(changelogEntries, {
    fields: [changelogEntryTags.changelogEntryId],
    references: [changelogEntries.id],
  }),
  tag: one(postTags, {
    fields: [changelogEntryTags.tagId],
    references: [postTags.id],
  }),
}))
