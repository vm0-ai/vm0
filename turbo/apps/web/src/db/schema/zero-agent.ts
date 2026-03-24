import {
  pgTable,
  uuid,
  timestamp,
  text,
  varchar,
  uniqueIndex,
  index,
  jsonb,
} from "drizzle-orm/pg-core";
import type { FirewallPolicies } from "@vm0/core";

/**
 * Zero Agents table
 * Stores agent metadata (display name, description, sound) as first-class columns.
 * Keyed by org_id + name to match agent_composes unique constraint.
 */
export const zeroAgents = pgTable(
  "zero_agents",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    name: varchar("name", { length: 64 }).notNull(),
    displayName: varchar("display_name", { length: 256 }),
    description: text("description"),
    sound: varchar("sound", { length: 64 }),
    firewallPolicies: jsonb("firewall_policies").$type<FirewallPolicies>(),
    connectors: jsonb("connectors").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    orgNameIdx: uniqueIndex("idx_zero_agents_org_name").on(
      table.orgId,
      table.name,
    ),
    orgIdx: index("idx_zero_agents_org").on(table.orgId),
  }),
);
