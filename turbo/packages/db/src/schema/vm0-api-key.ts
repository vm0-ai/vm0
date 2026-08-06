import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * VM0 API Keys table
 * Platform-managed key pool for the VM0 managed model provider.
 * Each vendor has one platform-managed key.
 */
export const vm0ApiKeys = pgTable(
  "vm0_api_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    vendor: varchar("vendor", { length: 50 }).notNull(),
    apiKey: text("api_key").notNull(),
    label: text("label"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [uniqueIndex("idx_vm0_api_keys_vendor").on(table.vendor)];
  },
);
