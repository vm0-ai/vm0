import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

/**
 * VM0 API Keys table
 * Platform-managed key pool for the VM0 managed model provider.
 * Keys are grouped by vendor and associated with specific models.
 */
export const vm0ApiKeys = pgTable(
  "vm0_api_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    vendor: varchar("vendor", { length: 50 }).notNull(),
    model: varchar("model", { length: 255 }).notNull(),
    apiKey: text("api_key").notNull(),
    label: text("label"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [index("idx_vm0_api_keys_vendor").on(table.vendor)];
  },
);
