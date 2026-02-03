import {
  pgTable,
  uuid,
  varchar,
  boolean,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { scopes } from "./scope";
import { credentials } from "./credential";

/**
 * Model Providers table
 * Stores metadata for model provider configurations
 * Actual credentials stored in credentials table via FK
 *
 * For legacy single-credential providers: uses credentialId
 * For multi-auth providers (like aws-bedrock): uses authMethod + credentials stored separately
 */
export const modelProviders = pgTable(
  "model_providers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    scopeId: uuid("scope_id")
      .references(() => scopes.id, { onDelete: "cascade" })
      .notNull(),
    type: varchar("type", { length: 50 }).notNull(),
    // Legacy single credential FK - null for multi-auth providers
    credentialId: uuid("credential_id").references(() => credentials.id, {
      onDelete: "cascade",
    }),
    // Auth method for multi-auth providers (e.g., "api-key", "access-keys")
    authMethod: varchar("auth_method", { length: 50 }),
    isDefault: boolean("is_default").notNull().default(false),
    selectedModel: varchar("selected_model", { length: 255 }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_model_providers_scope_type").on(table.scopeId, table.type),
    index("idx_model_providers_scope").on(table.scopeId),
    index("idx_model_providers_credential").on(table.credentialId),
  ],
);
