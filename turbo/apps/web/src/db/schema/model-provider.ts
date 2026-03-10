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
    scopeId: uuid("scope_id").notNull(),
    type: varchar("type", { length: 50 }).notNull(),
    // Legacy single secret FK - null for multi-auth providers
    secretId: uuid("secret_id").references(() => secrets.id, {
      onDelete: "cascade",
    }),
    // Auth method for multi-auth providers (e.g., "api-key", "access-keys")
    authMethod: varchar("auth_method", { length: 50 }),
    isDefault: boolean("is_default").notNull().default(false),
    selectedModel: varchar("selected_model", { length: 255 }),
    userId: text("user_id").notNull(),
    clerkOrgId: text("clerk_org_id").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_model_providers_secret").on(table.secretId),
    index("idx_model_providers_clerk_org").on(table.clerkOrgId),
    uniqueIndex("idx_model_providers_clerk_org_user_type").on(
      table.clerkOrgId,
      table.userId,
      table.type,
    ),
  ],
);
