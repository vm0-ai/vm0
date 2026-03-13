import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const cliTokens = pgTable("cli_tokens", {
  id: uuid("id").defaultRandom().primaryKey(),
  token: text("token").unique().notNull(), // vm0_live_xxxxx...
  userId: text("user_id").notNull(), // Clerk user ID
  name: text("name").notNull(), // User-friendly name
  expiresAt: timestamp("expires_at").notNull(),
  lastUsedAt: timestamp("last_used_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
