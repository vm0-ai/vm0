import {
  pgTable,
  text,
  boolean,
  bigint,
  timestamp,
  primaryKey,
  jsonb,
} from "drizzle-orm/pg-core";

/**
 * org_members_metadata — source of truth for per-member preferences.
 * Replaces Clerk membership publicMetadata for preference storage.
 */
export const orgMembersMetadata = pgTable(
  "org_members_metadata",
  {
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    timezone: text("timezone"),
    pinnedAgentIds: jsonb("pinned_agent_ids").$type<string[]>().default([]),
    sendMode: text("send_mode").notNull().default("enter"),
    onboardingDone: boolean("onboarding_done").notNull().default(false),
    creditCap: bigint("credit_cap", { mode: "number" }),
    creditEnabled: boolean("credit_enabled").notNull().default(true),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.orgId, table.userId] })],
);
