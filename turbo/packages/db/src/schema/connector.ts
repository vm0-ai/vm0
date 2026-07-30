import {
  bigint,
  check,
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  unique,
  uniqueIndex,
  index,
  foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { orgCustomConnectors } from "./org-custom-connector";

/**
 * Connectors table
 * Stores metadata for connected third-party services (GitHub, etc.)
 * Actual secrets stored in secrets table with type="connector"
 * A connection belongs to either one built-in connector type or one
 * organization-defined custom connector.
 */
export const connectors = pgTable(
  "connectors",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // Compatibility bridge for pre-#23793 releases. Remove in #23794.
    legacyType: varchar("type", { length: 64 }), // "github"
    connectorSlug: varchar("connector_slug", { length: 64 }),
    customConnectorId: uuid("custom_connector_id"),
    authMethod: varchar("auth_method", { length: 50 }).notNull(), // "oauth"
    storageVersion: bigint("storage_version", { mode: "number" }).notNull(),

    // External account info (from OAuth)
    externalId: varchar("external_id", { length: 255 }),
    externalUsername: varchar("external_username", { length: 255 }),
    externalEmail: varchar("external_email", { length: 255 }),
    oauthScopes: text("oauth_scopes"), // JSON array of scopes
    tokenExpiresAt: timestamp("token_expires_at"), // null = unknown; refreshable OAuth connectors auto-refresh on next use to backfill
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),

    needsReconnect: boolean("needs_reconnect").notNull().default(false),
    reconnectReason: varchar("reconnect_reason", { length: 64 }),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_connectors_org").on(table.orgId),
      uniqueIndex("idx_connectors_org_user_type")
        .on(table.orgId, table.userId, table.legacyType)
        .where(sql`${table.legacyType} IS NOT NULL`),
      uniqueIndex("idx_connectors_org_user_custom_connector")
        .on(table.orgId, table.userId, table.customConnectorId)
        .where(sql`${table.customConnectorId} IS NOT NULL`),
      unique("idx_connectors_id_org_user").on(
        table.id,
        table.orgId,
        table.userId,
      ),
      foreignKey({
        name: "fk_connectors_custom_connector",
        columns: [table.customConnectorId, table.orgId],
        foreignColumns: [orgCustomConnectors.id, orgCustomConnectors.orgId],
      }).onDelete("cascade"),
      check(
        "chk_connectors_identity",
        sql`num_nonnulls(${table.legacyType}, ${table.customConnectorId}) = 1`,
      ),
      uniqueIndex("idx_connectors_org_user_slug")
        .on(table.orgId, table.userId, table.connectorSlug)
        .where(sql`${table.connectorSlug} IS NOT NULL`),
      check(
        "chk_connectors_storage_version_positive",
        sql`${table.storageVersion} > 0`,
      ),
      check(
        "chk_connectors_connector_slug_matches_type",
        sql`${table.connectorSlug} IS NOT DISTINCT FROM ${table.legacyType}`,
      ),
    ];
  },
);
