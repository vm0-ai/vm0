import {
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { scopes } from "./scope";

/**
 * Org access tokens table
 *
 * Short-lived tokens (2h) that encode both userId and scopeId.
 * Generated at `scope use` time after Clerk API membership verification.
 * Extends the vm0_live_* token pattern with a vm0_org_* prefix.
 */
export const orgAccessTokens = pgTable(
  "org_access_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    token: text("token").unique().notNull(),
    userId: text("user_id").notNull(),
    scopeId: uuid("scope_id")
      .references(() => scopes.id)
      .notNull(),
    role: varchar("role", { length: 20 }).notNull().default("member"),
    expiresAt: timestamp("expires_at").notNull(),
    lastUsedAt: timestamp("last_used_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    userScopeIdx: index("idx_org_access_tokens_user_scope").on(
      table.userId,
      table.scopeId,
    ),
  }),
);
