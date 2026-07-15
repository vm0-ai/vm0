import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

export const CONNECTOR_CATALOG_ATTEMPT_OUTCOMES = [
  "accepted",
  "unchanged",
  "rejected",
] as const;
export type ConnectorCatalogAttemptOutcome =
  (typeof CONNECTOR_CATALOG_ATTEMPT_OUTCOMES)[number];

export const CONNECTOR_CATALOG_FAILURE_CODES = [
  "source-unavailable",
  "object-too-large",
  "invalid-json",
  "invalid-pointer",
  "invalid-reference",
  "digest-mismatch",
  "unsupported-schema",
  "unsupported-capability",
  "invalid-artifact",
  "public-leakage",
  "relationship-mismatch",
  "conflicting-release",
] as const;
export type ConnectorCatalogFailureCode =
  (typeof CONNECTOR_CATALOG_FAILURE_CODES)[number];

export const connectorCatalogReleaseIdentities = pgTable(
  "connector_catalog_release_identities",
  {
    sourceId: varchar("source_id", { length: 64 }).notNull(),
    schemaVersion: integer("schema_version").notNull(),
    catalogVersion: varchar("catalog_version", { length: 255 }).notNull(),
    integrityKey: text("integrity_key").notNull(),
    integrityDigest: varchar("integrity_digest", { length: 71 }).notNull(),
    publicCatalogKey: text("public_catalog_key").notNull(),
    publicCatalogDigest: varchar("public_catalog_digest", {
      length: 71,
    }).notNull(),
    privateCatalogKey: text("private_catalog_key").notNull(),
    privateCatalogDigest: varchar("private_catalog_digest", {
      length: 71,
    }).notNull(),
    privateFirewallsKey: text("private_firewalls_key").notNull(),
    privateFirewallsDigest: varchar("private_firewalls_digest", {
      length: 71,
    }).notNull(),
    runnerFirewallsKey: text("runner_firewalls_key").notNull(),
    runnerFirewallsDigest: varchar("runner_firewalls_digest", {
      length: 71,
    }).notNull(),
    requiredCapabilities: text("required_capabilities").array().notNull(),
    firstValidatedAt: timestamp("first_validated_at").notNull(),
  },
  (table) => {
    return [
      primaryKey({
        name: "connector_catalog_release_identities_pk",
        columns: [table.sourceId, table.schemaVersion, table.catalogVersion],
      }),
      check(
        "connector_catalog_release_schema_version_positive",
        sql`${table.schemaVersion} > 0`,
      ),
    ];
  },
);

export const connectorCatalogSyncState = pgTable(
  "connector_catalog_sync_state",
  {
    sourceId: varchar("source_id", { length: 64 }).notNull(),
    schemaVersion: integer("schema_version").notNull(),
    revision: integer("revision").default(0).notNull(),
    activeCatalogVersion: varchar("active_catalog_version", { length: 255 }),
    publicCatalog: text("public_catalog"),
    activatedAt: timestamp("activated_at"),
    lastAttemptAt: timestamp("last_attempt_at"),
    lastAttemptOutcome: varchar("last_attempt_outcome", {
      length: 32,
    }).$type<ConnectorCatalogAttemptOutcome>(),
    lastSuccessAt: timestamp("last_success_at"),
    lastFailureCode: varchar("last_failure_code", {
      length: 64,
    }).$type<ConnectorCatalogFailureCode>(),
  },
  (table) => {
    return [
      primaryKey({
        name: "connector_catalog_sync_state_pk",
        columns: [table.sourceId, table.schemaVersion],
      }),
      foreignKey({
        name: "connector_catalog_sync_state_active_release_fk",
        columns: [
          table.sourceId,
          table.schemaVersion,
          table.activeCatalogVersion,
        ],
        foreignColumns: [
          connectorCatalogReleaseIdentities.sourceId,
          connectorCatalogReleaseIdentities.schemaVersion,
          connectorCatalogReleaseIdentities.catalogVersion,
        ],
      }),
      check(
        "connector_catalog_sync_state_schema_version_positive",
        sql`${table.schemaVersion} > 0`,
      ),
      check(
        "connector_catalog_sync_state_revision_nonnegative",
        sql`${table.revision} >= 0`,
      ),
      check(
        "connector_catalog_sync_state_active_snapshot_complete",
        sql`(
          ${table.activeCatalogVersion} IS NULL
          AND ${table.publicCatalog} IS NULL
          AND ${table.activatedAt} IS NULL
        ) OR (
          ${table.activeCatalogVersion} IS NOT NULL
          AND ${table.publicCatalog} IS NOT NULL
          AND ${table.activatedAt} IS NOT NULL
        )`,
      ),
      check(
        "connector_catalog_sync_state_attempt_complete",
        sql`(
          ${table.lastAttemptOutcome} IS NULL
          AND ${table.lastAttemptAt} IS NULL
          AND ${table.lastFailureCode} IS NULL
        ) OR (
          ${table.lastAttemptOutcome} = 'rejected'
          AND ${table.lastAttemptAt} IS NOT NULL
          AND ${table.lastFailureCode} IS NOT NULL
        ) OR (
          ${table.lastAttemptOutcome} IN ('accepted', 'unchanged')
          AND ${table.lastAttemptAt} IS NOT NULL
          AND ${table.lastFailureCode} IS NULL
        )`,
      ),
    ];
  },
);
