/**
 * API Tokens Schema
 *
 * Stores API tokens for the public API v1.
 * Tokens are prefixed with `vm0_api_` and stored as hashes for security.
 */
import { pgTable, text, timestamp, uuid, index } from "drizzle-orm/pg-core";

export const apiTokens = pgTable(
  "api_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(), // Clerk user ID
    name: text("name").notNull(), // User-friendly name

    // Token is stored as hash for security
    // The actual token is only shown once on creation
    tokenHash: text("token_hash").unique().notNull(),

    // First 12 chars of token for identification (e.g., "vm0_api_xxxx")
    tokenPrefix: text("token_prefix").notNull(),

    // Scopes as JSON array (e.g., ["read:agents", "write:runs"])
    scopes: text("scopes").notNull(), // JSON array stored as text

    // Timestamps
    lastUsedAt: timestamp("last_used_at"),
    expiresAt: timestamp("expires_at"), // null = never expires
    revokedAt: timestamp("revoked_at"), // null = not revoked
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("api_tokens_user_id_idx").on(table.userId),
    index("api_tokens_token_hash_idx").on(table.tokenHash),
  ],
);

export type ApiToken = typeof apiTokens.$inferSelect;
export type NewApiToken = typeof apiTokens.$inferInsert;
