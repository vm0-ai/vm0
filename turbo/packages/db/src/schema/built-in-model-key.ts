import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Built-in model keys table
 * Platform-held key pool for the built-in model provider.
 * Each vendor has one platform-held key.
 */
export const builtInModelKeys = pgTable(
  "built_in_model_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    vendor: varchar("vendor", { length: 50 }).notNull(),
    apiKey: text("api_key").notNull(),
    label: text("label"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [uniqueIndex("idx_built_in_model_keys_vendor").on(table.vendor)];
  },
);
