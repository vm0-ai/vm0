import { sql } from "drizzle-orm";
import {
  check,
  customType,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import type { ConnectorCatalogFilteredAuthMethods } from "@vm0/db/jsonb-contracts/connector-catalog";

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
  "invalid-artifact",
  "public-leakage",
  "relationship-mismatch",
  "invalid-compression",
] as const;
export type ConnectorCatalogFailureCode =
  (typeof CONNECTOR_CATALOG_FAILURE_CODES)[number];

const byteaColumn = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const connectorCatalogSyncState = pgTable(
  "connector_catalog_sync_state",
  {
    sourceId: varchar("source_id", { length: 64 }).notNull(),
    schemaVersion: integer("schema_version").notNull(),
    revision: integer("revision").default(0).notNull(),
    lastObservedCatalogVersion: varchar("last_observed_catalog_version", {
      length: 255,
    }),
    // TODO(#22765): Remove deployment-overlap-only legacy columns.
    legacyLastObservedIntegrityDigest: varchar(
      "last_observed_integrity_digest",
      {
        length: 71,
      },
    ),
    lastObservedCatalogKey: text("last_observed_catalog_key"),
    lastObservedCatalogDigest: varchar("last_observed_catalog_digest", {
      length: 71,
    }),
    lastObservedPointerEtag: text("last_observed_pointer_etag"),
    lastAttemptAt: timestamp("last_attempt_at"),
    lastAttemptOutcome: varchar("last_attempt_outcome", {
      length: 32,
    }).$type<ConnectorCatalogAttemptOutcome>(),
    lastSuccessAt: timestamp("last_success_at"),
    lastFailureCode: varchar("last_failure_code", {
      length: 64,
    }).$type<ConnectorCatalogFailureCode>(),
    lastRejectedCatalogVersion: varchar("last_rejected_catalog_version", {
      length: 255,
    }),
    legacyLastRejectedIntegrityDigest: varchar(
      "last_rejected_integrity_digest",
      {
        length: 71,
      },
    ),
    lastRejectedCatalogKey: text("last_rejected_catalog_key"),
    lastRejectedCatalogDigest: varchar("last_rejected_catalog_digest", {
      length: 71,
    }),
    lastRejectedPointerEtag: text("last_rejected_pointer_etag"),
    lastRejectedFailureCode: varchar("last_rejected_failure_code", {
      length: 64,
    }).$type<ConnectorCatalogFailureCode>(),
  },
  (table) => {
    return [
      primaryKey({
        name: "connector_catalog_sync_state_pk",
        columns: [table.sourceId, table.schemaVersion],
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
        "connector_catalog_sync_state_observed_identity_complete",
        sql`(
          ${table.lastObservedCatalogVersion} IS NULL
          AND ${table.lastObservedCatalogKey} IS NULL
          AND ${table.lastObservedCatalogDigest} IS NULL
        ) OR (
          ${table.lastObservedCatalogVersion} IS NOT NULL
          AND ${table.lastObservedCatalogKey} IS NOT NULL
          AND ${table.lastObservedCatalogDigest} IS NOT NULL
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
      check(
        "connector_catalog_sync_state_rejected_candidate_complete",
        sql`(
          ${table.lastRejectedCatalogVersion} IS NULL
          AND ${table.lastRejectedCatalogKey} IS NULL
          AND ${table.lastRejectedCatalogDigest} IS NULL
          AND ${table.lastRejectedPointerEtag} IS NULL
          AND ${table.lastRejectedFailureCode} IS NULL
        ) OR (
          ${table.lastRejectedFailureCode} IS NOT NULL
          AND ${table.lastRejectedFailureCode} <> 'source-unavailable'
          AND (
            (
              ${table.lastRejectedCatalogVersion} IS NOT NULL
              AND ${table.lastRejectedCatalogKey} IS NOT NULL
              AND ${table.lastRejectedCatalogDigest} IS NOT NULL
            ) OR ${table.lastRejectedPointerEtag} IS NOT NULL
          )
          AND (
            (
              ${table.lastRejectedCatalogVersion} IS NULL
              AND ${table.lastRejectedCatalogKey} IS NULL
              AND ${table.lastRejectedCatalogDigest} IS NULL
            ) OR (
              ${table.lastRejectedCatalogVersion} IS NOT NULL
              AND ${table.lastRejectedCatalogKey} IS NOT NULL
              AND ${table.lastRejectedCatalogDigest} IS NOT NULL
            )
          )
        )`,
      ),
    ];
  },
);

export const connectorCatalogActiveSnapshot = pgTable(
  "connector_catalog_active_snapshot",
  {
    sourceId: varchar("source_id", { length: 64 }).notNull(),
    schemaVersion: integer("schema_version").notNull(),
    catalogVersion: varchar("catalog_version", { length: 255 }).notNull(),
    // TODO(#22765): Remove deployment-overlap-only legacy columns.
    legacyIntegrityDigest: varchar("integrity_digest", { length: 71 }),
    catalogKey: text("catalog_key").notNull(),
    catalogDigest: varchar("catalog_digest", { length: 71 }).notNull(),
    catalogRawSize: integer("catalog_raw_size").notNull(),
    catalogGzip: byteaColumn("catalog_gzip").notNull(),
    legacyPublicCatalogDigest: varchar("public_catalog_digest", {
      length: 71,
    }),
    legacyPrivateCatalogDigest: varchar("private_catalog_digest", {
      length: 71,
    }),
    legacyPrivateFirewallsDigest: varchar("private_firewalls_digest", {
      length: 71,
    }),
    legacyRunnerFirewallsDigest: varchar("runner_firewalls_digest", {
      length: 71,
    }),
    legacyPublicCatalog: text("public_catalog"),
    legacyPrivateCatalog: text("private_catalog"),
    legacyPrivateFirewalls: text("private_firewalls"),
    legacyRunnerFirewalls: text("runner_firewalls"),
    activatedAt: timestamp("activated_at").notNull(),
  },
  (table) => {
    return [
      primaryKey({
        name: "connector_catalog_active_snapshot_pk",
        columns: [table.sourceId, table.schemaVersion],
      }),
      foreignKey({
        name: "connector_catalog_active_snapshot_sync_state_fk",
        columns: [table.sourceId, table.schemaVersion],
        foreignColumns: [
          connectorCatalogSyncState.sourceId,
          connectorCatalogSyncState.schemaVersion,
        ],
      }),
      check(
        "connector_catalog_active_snapshot_schema_version_positive",
        sql`${table.schemaVersion} > 0`,
      ),
      check(
        "connector_catalog_active_snapshot_catalog_raw_size_positive",
        sql`${table.catalogRawSize} > 0`,
      ),
      check(
        "connector_catalog_active_snapshot_catalog_digest_valid",
        sql`${table.catalogDigest} ~ '^sha256:[a-f0-9]{64}$'`,
      ),
    ];
  },
);

export const connectorCatalogCompatibilityEvaluation = pgTable(
  "connector_catalog_compatibility_evaluation",
  {
    sourceId: varchar("source_id", { length: 64 }).notNull(),
    schemaVersion: integer("schema_version").notNull(),
    catalogVersion: varchar("catalog_version", { length: 255 }).notNull(),
    // TODO(#22765): Remove the deployment-overlap-only legacy column.
    legacyIntegrityDigest: varchar("integrity_digest", { length: 71 }),
    catalogDigest: varchar("catalog_digest", { length: 71 }).notNull(),
    executableCapabilityDigest: varchar("executable_capability_digest", {
      length: 71,
    }).notNull(),
    evaluatedAt: timestamp("evaluated_at").notNull(),
    filteredAuthMethods: jsonb("filtered_auth_methods")
      .$type<ConnectorCatalogFilteredAuthMethods>()
      .notNull(),
  },
  (table) => {
    return [
      primaryKey({
        name: "connector_catalog_compatibility_evaluation_pk",
        columns: [
          table.sourceId,
          table.schemaVersion,
          table.catalogVersion,
          table.catalogDigest,
          table.executableCapabilityDigest,
        ],
      }),
      foreignKey({
        name: "connector_catalog_compatibility_evaluation_sync_state_fk",
        columns: [table.sourceId, table.schemaVersion],
        foreignColumns: [
          connectorCatalogSyncState.sourceId,
          connectorCatalogSyncState.schemaVersion,
        ],
      }),
      check(
        "connector_catalog_compat_eval_schema_version_positive",
        sql`${table.schemaVersion} > 0`,
      ),
      check(
        "connector_catalog_compatibility_evaluation_digest_valid",
        sql`${table.executableCapabilityDigest} ~ '^sha256:[a-f0-9]{64}$'`,
      ),
      check(
        "connector_catalog_compatibility_catalog_digest_valid",
        sql`${table.catalogDigest} ~ '^sha256:[a-f0-9]{64}$'`,
      ),
    ];
  },
);
