import { pgTable, uuid, varchar, timestamp } from "drizzle-orm/pg-core";

/**
 * API Keys table
 * Stores hashed API keys for authentication
 */
export const apiKeys = pgTable("api_keys", {
  id: uuid("id").defaultRandom().primaryKey(),
  keyHash: varchar("key_hash", { length: 255 }).notNull().unique(),
  name: varchar("name", { length: 100 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  lastUsedAt: timestamp("last_used_at"),
});
