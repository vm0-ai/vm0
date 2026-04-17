import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

/**
 * Connectors table
 * Stores metadata for connected third-party services (GitHub, etc.)
 * Actual secrets stored in secrets table with type="connector"
 * Linked by (orgId, userId, type) unique index
 */
export const connectors = pgTable(
  "connectors",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    type: varchar("type", { length: 50 }).notNull(), // "github"
    authMethod: varchar("auth_method", { length: 50 }).notNull(), // "oauth"

    // External account info (from OAuth)
    externalId: varchar("external_id", { length: 255 }),
    externalUsername: varchar("external_username", { length: 255 }),
    externalEmail: varchar("external_email", { length: 255 }),
    oauthScopes: text("oauth_scopes"), // JSON array of scopes
    tokenExpiresAt: timestamp("token_expires_at"), // null = unknown; refreshable OAuth connectors auto-refresh on next use to backfill
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),

    needsReconnect: boolean("needs_reconnect").notNull().default(false),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_connectors_org").on(table.orgId),
      uniqueIndex("idx_connectors_org_user_type").on(
        table.orgId,
        table.userId,
        table.type,
      ),
    ];
  },
);
