import {
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { scopes } from "./scope";

/**
 * Credentials table
 * Stores encrypted third-party service credentials at scope level
 * Values encrypted with AES-256-GCM using SECRETS_ENCRYPTION_KEY
 *
 * Scoped to user's personal scope initially, supports organization scopes in future
 */
export const credentials = pgTable(
  "credentials",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    scopeId: uuid("scope_id")
      .references(() => scopes.id, { onDelete: "cascade" })
      .notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    encryptedValue: text("encrypted_value").notNull(),
    description: text("description"),
    type: varchar("type", { length: 50 }).notNull().default("user"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_credentials_scope_name").on(table.scopeId, table.name),
    index("idx_credentials_scope").on(table.scopeId),
    index("idx_credentials_type").on(table.type),
  ],
);
