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
 * Organization invitations table
 * Stores invite links for joining organizations
 */
export const orgInvitations = pgTable(
  "org_invitations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    scopeId: uuid("scope_id")
      .notNull()
      .references(() => scopes.id, { onDelete: "cascade" }),
    token: varchar("token", { length: 64 }).notNull().unique(),
    invitedBy: text("invited_by").notNull(), // Clerk user ID
    expiresAt: timestamp("expires_at").notNull(),
    usedAt: timestamp("used_at"),
    usedBy: text("used_by"), // Clerk user ID of who used it
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_org_invitations_token").on(table.token),
    index("idx_org_invitations_scope").on(table.scopeId),
  ],
);
