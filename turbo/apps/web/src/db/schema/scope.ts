import {
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  index,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Scopes table
 * Provides namespace isolation for resources (images, storages, etc.)
 * Every scope is backed by a Clerk Organization.
 */
export const scopes = pgTable(
  "scopes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slug: varchar("slug", { length: 64 }).notNull().unique(),
    clerkOrgId: text("clerk_org_id").notNull(),
    tier: varchar("tier", { length: 16 }).default("free").notNull(),
    // FK to agent_composes(id) ON DELETE SET NULL — managed via raw migration
    // to avoid circular Drizzle reference (agent_composes already references scopes)
    defaultAgentComposeId: uuid("default_agent_compose_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    clerkOrgIdx: index("idx_scopes_clerk_org").on(table.clerkOrgId),
    tierCheck: check(
      "scopes_tier_check",
      sql`${table.tier} IN ('free', 'pro', 'max')`,
    ),
  }),
);
