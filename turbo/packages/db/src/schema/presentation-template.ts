import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { PresentationTemplateError } from "@okouai/db/jsonb-contracts/presentation-template";
export type { PresentationTemplateError } from "@okouai/db/jsonb-contracts/presentation-template";

/**
 * Who can see a template. Private templates are visible only to their owner;
 * organization sharing is a later change that flips this column and widens the
 * list query, not a migration.
 */
export const PRESENTATION_TEMPLATE_VISIBILITIES = [
  "private",
  "public",
] as const;
export type PresentationTemplateVisibility =
  (typeof PRESENTATION_TEMPLATE_VISIBILITIES)[number];

/**
 * Import lifecycle. `pending` is written when the row is created, `processing`
 * once page images exist, `ready` once the package is published. `failed` is
 * terminal and carries `error`.
 */
export const PRESENTATION_TEMPLATE_STATUSES = [
  "pending",
  "processing",
  "ready",
  "failed",
] as const;
export type PresentationTemplateStatus =
  (typeof PRESENTATION_TEMPLATE_STATUSES)[number];

/**
 * Presentation templates compiled from a deck the user uploaded.
 *
 * The compiled package is not referenced by a column: it is the storage named
 * `presentation-template@{id}`, derived from the row id the same way
 * `zero_workflows` derives `custom-skill@{workflowId}`. One authoritative
 * location, nothing to keep in sync.
 *
 * `page_keys` holds R2 object keys rather than URLs, so how a page is served
 * stays a read-time decision. Array position is the page number and element 0
 * is the cover, so the page count is `array_length(page_keys, 1)` and never a
 * stored column. Page images are deliberately not `run_uploaded_files` rows:
 * that table's catalog trigger would project every slide crop into the user's
 * artifact catalog.
 */
export const presentationTemplates = pgTable(
  "presentation_templates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    visibility: varchar("visibility", { length: 16 })
      .$type<PresentationTemplateVisibility>()
      .notNull()
      .default("private"),
    title: text("title").notNull(),
    status: varchar("status", { length: 16 })
      .$type<PresentationTemplateStatus>()
      .notNull()
      .default("pending"),
    error: jsonb("error").$type<PresentationTemplateError>(),
    /** Object key of the uploaded deck, as assigned by the upload route. */
    sourceStorageKey: text("source_storage_key").notNull(),
    sourceFilename: text("source_filename").notNull(),
    pageKeys: text("page_keys")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Page width divided by height, written when the pages are committed. */
    aspectRatio: real("aspect_ratio"),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      // The picker lists one owner's templates, newest first.
      index("idx_presentation_templates_owner_created").on(
        table.orgId,
        table.ownerUserId,
        table.createdAt.desc(),
      ),
      // One import at a time per user, enforced in the database so repeated
      // upload clicks cannot launch several conversion runs.
      uniqueIndex("idx_presentation_templates_active_import")
        .on(table.ownerUserId)
        .where(sql`status IN ('pending', 'processing')`),
      check(
        "chk_presentation_templates_visibility",
        sql`${table.visibility} IN ('private', 'public')`,
      ),
      check(
        "chk_presentation_templates_status",
        sql`${table.status} IN ('pending', 'processing', 'ready', 'failed')`,
      ),
    ];
  },
);
