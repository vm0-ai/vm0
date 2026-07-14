import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import type { PresentationTemplateManifest } from "@vm0/db/jsonb-contracts/presentation-template";
import { storageVersions } from "./storage";

export const PRESENTATION_TEMPLATE_ACCESS_SCOPES = [
  "private",
  "organization",
] as const;
export type PresentationTemplateAccessScope =
  (typeof PRESENTATION_TEMPLATE_ACCESS_SCOPES)[number];

export const PRESENTATION_TEMPLATE_IMPORT_STATUSES = [
  "uploading",
  "queued",
  "processing",
  "succeeded",
  "failed",
] as const;
export type PresentationTemplateImportStatus =
  (typeof PRESENTATION_TEMPLATE_IMPORT_STATUSES)[number];

export const presentationTemplates = pgTable(
  "presentation_templates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    name: varchar("name", { length: 256 }).notNull(),
    description: text("description"),
    accessScope: varchar("access_scope", { length: 16 })
      .$type<PresentationTemplateAccessScope>()
      .notNull()
      .default("private"),
    activeRevisionId: uuid("active_revision_id").references(
      (): AnyPgColumn => {
        return presentationTemplateRevisions.id;
      },
      { onDelete: "set null" },
    ),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    archivedAt: timestamp("archived_at"),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => {
    return [
      index("idx_presentation_templates_org").on(table.orgId),
      index("idx_presentation_templates_org_owner").on(
        table.orgId,
        table.ownerUserId,
      ),
      index("idx_presentation_templates_active_revision").on(
        table.activeRevisionId,
      ),
      uniqueIndex("idx_presentation_templates_org_name_unique")
        .on(table.orgId, sql`lower(${table.name})`)
        .where(
          sql`${table.accessScope} = 'organization' AND ${table.deletedAt} IS NULL`,
        ),
      uniqueIndex("idx_presentation_templates_private_name_unique")
        .on(table.orgId, table.ownerUserId, sql`lower(${table.name})`)
        .where(
          sql`${table.accessScope} = 'private' AND ${table.deletedAt} IS NULL`,
        ),
      check(
        "chk_presentation_templates_access_scope",
        sql`${table.accessScope} IN ('private', 'organization')`,
      ),
    ];
  },
);

export const presentationTemplateImports = pgTable(
  "presentation_template_imports",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    templateId: uuid("template_id")
      .notNull()
      .references(
        () => {
          return presentationTemplates.id;
        },
        { onDelete: "cascade" },
      ),
    status: varchar("status", { length: 16 })
      .$type<PresentationTemplateImportStatus>()
      .notNull()
      .default("uploading"),
    sourceFilename: varchar("source_filename", { length: 512 }).notNull(),
    sourceStorageVersionId: varchar("source_storage_version_id", {
      length: 64,
    }).references(
      () => {
        return storageVersions.id;
      },
      { onDelete: "restrict" },
    ),
    compilerVersion: varchar("compiler_version", { length: 64 }),
    compileRunId: text("compile_run_id"),
    errorCode: varchar("error_code", { length: 64 }),
    errorMessage: text("error_message"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    uploadCommittedAt: timestamp("upload_committed_at"),
    processingStartedAt: timestamp("processing_started_at"),
    completedAt: timestamp("completed_at"),
  },
  (table) => {
    return [
      index("idx_presentation_template_imports_template_created").on(
        table.templateId,
        table.createdAt.desc(),
      ),
      index("idx_presentation_template_imports_org_status").on(
        table.orgId,
        table.status,
      ),
      index("idx_presentation_template_imports_compile_run").on(
        table.compileRunId,
      ),
      index("idx_presentation_template_imports_source_version").on(
        table.sourceStorageVersionId,
      ),
      uniqueIndex("idx_presentation_template_imports_one_active")
        .on(table.templateId)
        .where(sql`${table.status} IN ('uploading', 'queued', 'processing')`),
      check(
        "chk_presentation_template_imports_status",
        sql`${table.status} IN ('uploading', 'queued', 'processing', 'succeeded', 'failed')`,
      ),
      check(
        "chk_presentation_template_imports_source",
        sql`${table.status} IN ('uploading', 'failed') OR ${table.sourceStorageVersionId} IS NOT NULL`,
      ),
      check(
        "chk_presentation_template_imports_terminal",
        sql`(${table.status} = 'succeeded' AND ${table.completedAt} IS NOT NULL AND ${table.errorCode} IS NULL AND ${table.errorMessage} IS NULL) OR (${table.status} = 'failed' AND ${table.completedAt} IS NOT NULL AND ${table.errorCode} IS NOT NULL) OR ${table.status} IN ('uploading', 'queued', 'processing')`,
      ),
    ];
  },
);

export const presentationTemplateRevisions = pgTable(
  "presentation_template_revisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    templateId: uuid("template_id")
      .notNull()
      .references(
        () => {
          return presentationTemplates.id;
        },
        { onDelete: "cascade" },
      ),
    revisionNumber: integer("revision_number").notNull(),
    sourceImportId: uuid("source_import_id")
      .notNull()
      .references(
        () => {
          return presentationTemplateImports.id;
        },
        { onDelete: "restrict" },
      ),
    sourceStorageVersionId: varchar("source_storage_version_id", {
      length: 64,
    })
      .notNull()
      .references(
        () => {
          return storageVersions.id;
        },
        { onDelete: "restrict" },
      ),
    packageStorageVersionId: varchar("package_storage_version_id", {
      length: 64,
    })
      .notNull()
      .references(
        () => {
          return storageVersions.id;
        },
        { onDelete: "restrict" },
      ),
    compilerVersion: varchar("compiler_version", { length: 64 }).notNull(),
    manifest: jsonb("manifest").$type<PresentationTemplateManifest>().notNull(),
    previewS3Prefix: text("preview_s3_prefix").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_presentation_template_revisions_number_unique").on(
        table.templateId,
        table.revisionNumber,
      ),
      uniqueIndex("idx_presentation_template_revisions_import_unique").on(
        table.sourceImportId,
      ),
      index("idx_presentation_template_revisions_org").on(table.orgId),
      index("idx_presentation_template_revisions_package_version").on(
        table.packageStorageVersionId,
      ),
      check(
        "chk_presentation_template_revisions_number",
        sql`${table.revisionNumber} > 0`,
      ),
    ];
  },
);
