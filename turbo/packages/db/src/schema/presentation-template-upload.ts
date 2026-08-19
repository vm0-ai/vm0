import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { presentationTemplates } from "./presentation-template";

/**
 * Which slot of an import an uploaded object fills. `source` is the original
 * deck; `page` is one browser-rendered slide image identified by `page_index`.
 */
export const PRESENTATION_TEMPLATE_UPLOAD_ROLES = ["source", "page"] as const;
export type PresentationTemplateUploadRole =
  (typeof PRESENTATION_TEMPLATE_UPLOAD_ROLES)[number];

/**
 * Staging rows for one in-progress template import.
 *
 * The browser never names object ids at commit time. It asks this import for an
 * upload slot, the API allocates the object and records the row here, and
 * commit reads its own rows. A client cannot pair one deck's source with
 * another deck's pages because it never supplies the pairing.
 *
 * Rows are staging state only. Commit freezes the ordered result into
 * `presentation_templates.source_storage_key` and `page_keys` and deletes them,
 * so a committed template is readable without joining this table.
 */
export const presentationTemplateUploads = pgTable(
  "presentation_template_uploads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    templateId: uuid("template_id")
      .notNull()
      .references(
        () => {
          return presentationTemplates.id;
        },
        { onDelete: "cascade" },
      ),
    role: varchar("role", { length: 16 })
      .$type<PresentationTemplateUploadRole>()
      .notNull(),
    /** Zero-based slide position; null for the source deck. */
    pageIndex: integer("page_index"),
    storageKey: text("storage_key").notNull(),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      // Commit reads every slot of one import in page order.
      index("idx_presentation_template_uploads_template").on(
        table.templateId,
        table.pageIndex,
      ),
      // Re-requesting a slot replaces it instead of adding a duplicate.
      uniqueIndex("idx_presentation_template_uploads_source")
        .on(table.templateId)
        .where(sql`role = 'source'`),
      uniqueIndex("idx_presentation_template_uploads_page")
        .on(table.templateId, table.pageIndex)
        .where(sql`role = 'page'`),
      check(
        "chk_presentation_template_uploads_role",
        sql`${table.role} IN ('source', 'page')`,
      ),
      check(
        "chk_presentation_template_uploads_page_index",
        sql`(${table.role} = 'page' AND ${table.pageIndex} >= 0) OR (${table.role} = 'source' AND ${table.pageIndex} IS NULL)`,
      ),
    ];
  },
);
