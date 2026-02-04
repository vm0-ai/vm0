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
    scopeId: uuid("scope_id")
      .references(() => scopes.id, { onDelete: "cascade" })
      .notNull(),
    type: varchar("type", { length: 50 }).notNull(),
    // Legacy single secret FK - null for multi-auth providers
    secretId: uuid("secret_id").references(() => secrets.id, {
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
    index("idx_model_providers_secret").on(table.secretId),
  ],
);
