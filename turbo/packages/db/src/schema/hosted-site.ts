import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { HostedSiteManifest } from "@vm0/db/jsonb-contracts/hosted-site";
export type {
  HostedSiteManifest,
  HostedSiteManifestFile,
} from "@vm0/db/jsonb-contracts/hosted-site";

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
    ];
  },
);
