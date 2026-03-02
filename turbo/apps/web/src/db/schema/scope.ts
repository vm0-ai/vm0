import {
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  boolean,
  pgEnum,
  index,
} from "drizzle-orm/pg-core";

/**
 * Scope types:
 * - "personal": Individual user's scope
 * - "organization": Organization/team scope
 */
export const scopeTypeEnum = pgEnum("scope_type", ["personal", "organization"]);

export type ScopeType = "personal" | "organization";

/**
 * Scopes table
 * Provides namespace isolation for resources (images, storages, etc.)
 */
export const scopes = pgTable(
  "scopes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slug: varchar("slug", { length: 64 }).notNull().unique(),
    type: scopeTypeEnum("type").notNull().default("personal"),
    ownerId: text("owner_id"), // Clerk user ID
    timezone: varchar("timezone", { length: 50 }), // IANA timezone (e.g., "Asia/Shanghai")
    clerkOrgId: text("clerk_org_id"), // Clerk Organization ID, null for personal scopes
    notifyEmail: boolean("notify_email").default(false).notNull(),
    notifySlack: boolean("notify_slack").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    ownerIdx: index("idx_scopes_owner").on(table.ownerId),
    typeIdx: index("idx_scopes_type").on(table.type),
    clerkOrgIdx: index("idx_scopes_clerk_org").on(table.clerkOrgId),
  }),
);
