import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { scopes } from "./scope";

/**
 * Connectors table
 * Stores metadata for connected third-party services (GitHub, etc.)
 * Actual secrets stored in secrets table with type="connector"
 * Linked by (scopeId, name, type) - no FK needed
 */
export const connectors = pgTable(
  "connectors",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    scopeId: uuid("scope_id")
      .references(() => scopes.id, { onDelete: "cascade" })
      .notNull(),
    type: varchar("type", { length: 50 }).notNull(), // "github"
    authMethod: varchar("auth_method", { length: 50 }).notNull(), // "oauth"

    // Platform managing this connector (self-hosted or nango)
    platform: varchar("platform", { length: 50 })
      .notNull()
      .default("self-hosted"),
    // Nango connection ID (only for nango platform)
    nangoConnectionId: varchar("nango_connection_id", { length: 255 }),

    // External account info (from OAuth)
    externalId: varchar("external_id", { length: 255 }),
    externalUsername: varchar("external_username", { length: 255 }),
    externalEmail: varchar("external_email", { length: 255 }),
    oauthScopes: text("oauth_scopes"), // JSON array of scopes

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    // One connector per type per user
    uniqueIndex("idx_connectors_scope_type").on(table.scopeId, table.type),
    index("idx_connectors_scope").on(table.scopeId),
    index("idx_connectors_platform").on(table.platform),
  ],
);
