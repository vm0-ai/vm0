import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { runUploadedFiles } from "./run-uploaded-file";

export const IMAGE_REFERENCE_VISIBILITIES = ["private", "public"] as const;
export type ImageReferenceVisibility =
  (typeof IMAGE_REFERENCE_VISIBILITIES)[number];

/**
 * Reusable source images backed by one canonical private artifact upload.
 * `public` means visible only to members of the owning organization.
 */
export const imageReferences = pgTable(
  "image_references",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    sourceFileId: uuid("source_file_id")
      .notNull()
      .references(
        () => {
          return runUploadedFiles.id;
        },
        { onDelete: "restrict" },
      ),
    title: text("title").notNull(),
    visibility: varchar("visibility", { length: 16 })
      .$type<ImageReferenceVisibility>()
      .notNull()
      .default("private"),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      unique("uq_image_references_source_file").on(table.sourceFileId),
      index("idx_image_references_owner_created").on(
        table.orgId,
        table.ownerUserId,
        table.createdAt.desc(),
        table.id.desc(),
      ),
      index("idx_image_references_org_public_created")
        .on(table.orgId, table.createdAt.desc(), table.id.desc())
        .where(sql`${table.visibility} = 'public'`),
      check(
        "chk_image_references_visibility",
        sql`${table.visibility} IN ('private', 'public')`,
      ),
      check(
        "chk_image_references_title",
        sql`char_length(trim(${table.title})) BETWEEN 1 AND 80`,
      ),
      check(
        "chk_image_references_dimensions",
        sql`${table.width} > 0 AND ${table.height} > 0 AND ${table.width} <= 16384 AND ${table.height} <= 16384 AND ${table.width} * ${table.height} <= 67108864`,
      ),
    ];
  },
);
