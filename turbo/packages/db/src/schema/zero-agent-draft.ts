import type { PersistedAttachment } from "@vm0/api-contracts/contracts/chat-threads";
import {
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { zeroAgents } from "./zero-agent";

export const zeroAgentDrafts = pgTable(
  "zero_agent_drafts",
  {
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    agentId: uuid("agent_id")
      .notNull()
      .references(
        () => {
          return zeroAgents.id;
        },
        { onDelete: "cascade" },
      ),
    draftContent: text("draft_content"),
    draftAttachments: jsonb("draft_attachments").$type<PersistedAttachment[]>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return {
      userOrgAgentIdx: uniqueIndex("idx_zero_agent_drafts_user_org_agent").on(
        table.userId,
        table.orgId,
        table.agentId,
      ),
    };
  },
);
