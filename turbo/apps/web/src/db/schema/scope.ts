import {
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  index,
  check,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { agentComposes } from "./agent-compose";

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
    defaultAgentComposeId: uuid("default_agent_compose_id").references(
      (): AnyPgColumn => agentComposes.id,
      { onDelete: "set null" },
    ),
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
