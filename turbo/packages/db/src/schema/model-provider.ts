import {
  pgTable,
  uuid,
  text,
  varchar,
  boolean,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { secrets } from "./secret";

/**
 * Model Providers table
 * Stores metadata for model provider configurations
 * Actual secrets stored in secrets table via FK
 *
 * For legacy single-secret providers: uses secretId
 * For multi-auth providers (like aws-bedrock): uses authMethod + secrets stored separately
 */
export const modelProviders = pgTable(
  "model_providers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    type: varchar("type", { length: 50 }).notNull(),
    // Legacy single secret FK - null for multi-auth providers
    secretId: uuid("secret_id").references(
      () => {
        return secrets.id;
      },
      {
        onDelete: "cascade",
      },
    ),
    // Auth method for multi-auth providers (e.g., "api-key", "access-keys")
    authMethod: varchar("auth_method", { length: 50 }),
    isDefault: boolean("is_default").notNull().default(false),
    selectedModel: varchar("selected_model", { length: 255 }),
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    // OAuth token state (mirrors `connectors`). Set/cleared by the firewall
    // refresh pipeline for OAuth-typed model providers (e.g. chatgpt-oauth-token).
    // null tokenExpiresAt = unknown; refreshable providers auto-refresh on next use.
    tokenExpiresAt: timestamp("token_expires_at"),
    needsReconnect: boolean("needs_reconnect").notNull().default(false),
    // Captures ChatgptRefreshError.code (or equivalent) on refresh failure;
    // null on success or non-OAuth providers. Wave 3 stale-UX renders this.
    lastRefreshErrorCode: varchar("last_refresh_error_code", { length: 64 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      index("idx_model_providers_secret").on(table.secretId),
      index("idx_model_providers_org").on(table.orgId),
      uniqueIndex("idx_model_providers_org_user_type").on(
        table.orgId,
        table.userId,
        table.type,
      ),
      uniqueIndex("idx_model_providers_one_default_per_user")
        .on(table.orgId, table.userId)
        .where(sql`is_default = true`),
    ];
  },
);
