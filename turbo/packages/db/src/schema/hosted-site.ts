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

export const HOSTED_DEPLOYMENT_STATUSES = [
  "uploading",
  "ready",
  "failed",
  "deleted",
] as const;
export type HostedDeploymentStatus =
  (typeof HOSTED_DEPLOYMENT_STATUSES)[number];

export interface HostedSiteManifestFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly contentType: string;
  readonly immutable?: boolean;
}

export interface HostedSiteManifest {
  readonly version: 1;
  readonly deploymentId: string;
  readonly siteId: string;
  readonly publicSlug: string;
  readonly createdAt: string;
  readonly spaFallback: boolean;
  readonly files: Record<string, HostedSiteManifestFile>;
}

export const hostedSites = pgTable(
  "hosted_sites",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    slug: varchar("slug", { length: 64 }).notNull(),
    publicSlug: varchar("public_slug", { length: 96 }).notNull(),
    activeDeploymentId: uuid("active_deployment_id"),
    createdFromRunId: text("created_from_run_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => {
    return [
      index("idx_hosted_sites_org").on(table.orgId),
      uniqueIndex("idx_hosted_sites_org_slug").on(table.orgId, table.slug),
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
      index("idx_hosted_deployments_org").on(table.orgId),
      index("idx_hosted_deployments_status").on(table.status),
    ];
  },
);
