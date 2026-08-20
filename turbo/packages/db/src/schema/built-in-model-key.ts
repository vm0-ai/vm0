import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  integer,
  check,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Built-in model keys table
 * Platform-held key pool for the built-in model provider.
 * Each vendor has one platform-held key.
 */
export const builtInModelKeys = pgTable(
  "vm0_api_keys",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    vendor: varchar("vendor", { length: 50 }).notNull(),
    apiKey: text("api_key").notNull(),
    revision: integer("revision").default(1).notNull(),
    label: text("label"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [
      uniqueIndex("idx_vm0_api_keys_vendor").on(table.vendor),
      check("vm0_api_keys_revision_check", sql`${table.revision} > 0`),
    ];
  },
);
