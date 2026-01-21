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
 * Stores metadata for LLM backend configurations
 * Actual credentials stored in credentials table via FK
 */
export const modelProviders = pgTable(
  "model_providers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    scopeId: uuid("scope_id")
      .references(() => scopes.id, { onDelete: "cascade" })
      .notNull(),
    type: varchar("type", { length: 50 }).notNull(),
    credentialId: uuid("credential_id")
      .references(() => credentials.id, { onDelete: "cascade" })
      .notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_model_providers_scope_type").on(table.scopeId, table.type),
    index("idx_model_providers_scope").on(table.scopeId),
    index("idx_model_providers_credential").on(table.credentialId),
  ],
);
