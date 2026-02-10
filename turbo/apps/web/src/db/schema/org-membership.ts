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
 * Organization membership role:
 * - "owner": Organization creator, full control
 * - "member": Regular member, can use resources
 */
export type OrgMembershipRole = "owner" | "member";

/**
 * Organization memberships table
 * Tracks which users are members of which organization scopes
 */
export const orgMemberships = pgTable(
  "org_memberships",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    scopeId: uuid("scope_id")
      .notNull()
      .references(() => scopes.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(), // Clerk user ID
    role: varchar("role", { length: 20 }).notNull().default("member"),
    joinedAt: timestamp("joined_at").defaultNow(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_org_memberships_scope_user").on(
      table.scopeId,
      table.userId,
    ),
    index("idx_org_memberships_scope").on(table.scopeId),
    index("idx_org_memberships_user").on(table.userId),
  ],
);
