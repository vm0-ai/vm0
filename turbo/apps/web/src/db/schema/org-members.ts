import {
  pgTable,
  text,
  boolean,
  timestamp,
  primaryKey,
  jsonb,
} from "drizzle-orm/pg-core";

/**
 * org_members — source of truth for per-member preferences.
 * Replaces Clerk membership publicMetadata for preference storage.
 */
export const orgMembers = pgTable(
  "org_members",
  {
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    timezone: text("timezone"),
    notifyEmail: boolean("notify_email").notNull().default(false),
    notifySlack: boolean("notify_slack").notNull().default(true),
    pinnedAgentIds: jsonb("pinned_agent_ids").$type<string[]>().default([]),
    sendMode: text("send_mode").notNull().default("enter"),
    onboardingDone: boolean("onboarding_done").notNull().default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.orgId, table.userId] })],
);
