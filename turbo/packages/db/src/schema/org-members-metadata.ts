import {
  pgTable,
  text,
  boolean,
  integer,
  timestamp,
  primaryKey,
  jsonb,
  varchar,
} from "drizzle-orm/pg-core";
import type { OrgMembersPinnedAgentIds } from "@okouai/db/jsonb-contracts/org-members-metadata";
import type { ChatThreadServiceTier } from "@okouai/api-contracts/contracts/chat-threads";

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
    locale: text("locale"),
    onboardingRole: text("onboarding_role"),
    pinnedAgentIds: jsonb("pinned_agent_ids")
      .$type<OrgMembersPinnedAgentIds>()
      .default([]),
    sendMode: text("send_mode").notNull().default("enter"),
    // Opt-in: rollout must not flip existing members on by default.
    morningBriefEnabled: boolean("morning_brief_enabled")
      .notNull()
      .default(false),
    selectedModel: varchar("selected_model", { length: 255 }),
    serviceTier: varchar("service_tier", {
      length: 32,
    }).$type<ChatThreadServiceTier>(),
    /** Member default for built-in video generation. Seeds new chat threads. */
    selectedVideoModel: varchar("selected_video_model", { length: 255 }),
    onboardingDone: boolean("onboarding_done").notNull().default(false),
    captureNetworkBodiesRemaining: integer(
      "capture_network_bodies_remaining",
    ).default(0),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return [primaryKey({ columns: [table.orgId, table.userId] })];
  },
);
