import {
  bigint,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { HostedSiteManifest } from "@okouai/db/jsonb-contracts/hosted-site";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
export type {
  HostedSiteManifest,
  HostedSiteManifestFile,
} from "@okouai/db/jsonb-contracts/hosted-site";

export const HOSTED_DEPLOYMENT_STATUSES = [
  "uploading",
  "ready",
  "failed",
  "deleted",
] as const;
export type HostedDeploymentStatus =
  (typeof HOSTED_DEPLOYMENT_STATUSES)[number];

export const hostedSites = pgTable(
  "hosted_sites",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    // `slug` remains the rolling-deployment compatibility key for API
    // versions that still identify sites by (org_id, slug).
    slug: varchar("slug", { length: 64 }).notNull(),
    requestedSlug: varchar("requested_slug", { length: 64 }),
    // DB/API rollout fallback (observed maximum: ~102 minutes): existing rows
    // and writes from the previous API release are VM0. Remove this default
    // after that release is outside the rollback window; tracked by #27750.
    publicBrand: text("public_brand")
      .$type<PublicBrand>()
      .default("vm0")
      .notNull(),
    // Deliberately denormalized: deleting the originating thread must not
    // erase the site's ownership boundary.
    chatThreadId: uuid("chat_thread_id"),
    publicSlug: varchar("public_slug", { length: 96 }).notNull(),
    activeDeploymentId: uuid("active_deployment_id"),
    activeDeploymentVersion: integer("active_deployment_version"),
    nextDeploymentVersion: integer("next_deployment_version")
      .notNull()
      .default(1),
    createdFromRunId: text("created_from_run_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => {
    return [
      index("idx_hosted_sites_org").on(table.orgId),
      uniqueIndex("idx_hosted_sites_org_slug").on(table.orgId, table.slug),
      uniqueIndex("idx_hosted_sites_org_chat_thread_requested_slug")
        .on(table.orgId, table.chatThreadId, table.requestedSlug)
        .where(
          sql`${table.chatThreadId} IS NOT NULL AND ${table.requestedSlug} IS NOT NULL`,
        ),
      uniqueIndex("idx_hosted_sites_org_requested_slug_non_chat")
        .on(table.orgId, table.requestedSlug)
        .where(
          sql`${table.chatThreadId} IS NULL AND ${table.requestedSlug} IS NOT NULL`,
        ),
      uniqueIndex("idx_hosted_sites_public_slug").on(table.publicSlug),
      unique("idx_hosted_sites_id_public_brand").on(
        table.id,
        table.publicBrand,
      ),
    ];
  },
);

export const hostedDeployments = pgTable(
  "hosted_deployments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    siteId: uuid("site_id")
      .notNull()
      .references(
        () => {
          return hostedSites.id;
        },
        { onDelete: "cascade" },
      ),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    runId: text("run_id"),
    // DB/API rollout fallback (observed maximum: ~102 minutes): the previous
    // API omits this field and writes VM0. The composite foreign key below
    // fails closed for Okou sites. Remove after that API cannot return; #27750.
    publicBrand: text("public_brand")
      .$type<PublicBrand>()
      .default("vm0")
      .notNull(),
    status: varchar("status", { length: 32 })
      .$type<HostedDeploymentStatus>()
      .notNull()
      .default("uploading"),
    deploymentVersion: integer("deployment_version"),
    artifactUrl: text("artifact_url"),
    r2Prefix: text("r2_prefix").notNull(),
    manifest: jsonb("manifest").$type<HostedSiteManifest>().notNull(),
    manifestHash: varchar("manifest_hash", { length: 64 }).notNull(),
    contentHash: varchar("content_hash", { length: 64 }).notNull(),
    entrypoint: text("entrypoint").notNull().default("/index.html"),
    spaFallback: boolean("spa_fallback").notNull().default(false),
    fileCount: integer("file_count").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    url: text("url").notNull(),
    error: text("error"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    readyAt: timestamp("ready_at"),
  },
  (table) => {
    return [
      index("idx_hosted_deployments_site").on(table.siteId),
      uniqueIndex("idx_hosted_deployments_site_version")
        .on(table.siteId, table.deploymentVersion)
        .where(sql`${table.deploymentVersion} IS NOT NULL`),
      index("idx_hosted_deployments_org").on(table.orgId),
      index("idx_hosted_deployments_status").on(table.status),
      foreignKey({
        name: "fk_hosted_deployments_site_public_brand",
        columns: [table.siteId, table.publicBrand],
        foreignColumns: [hostedSites.id, hostedSites.publicBrand],
      }).onDelete("cascade"),
    ];
  },
);
