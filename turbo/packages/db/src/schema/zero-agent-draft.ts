import { sql } from "drizzle-orm";
import {
  check,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { zeroAgents } from "./zero-agent";
import type {
  ZeroAgentDraftAttachments,
  ZeroAgentDraftUserMessage,
} from "@vm0/db/jsonb-contracts/zero-agent-draft";

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
    /** Canonical rich document for the agent composer's saved draft. */
    draftUserMessage:
      jsonb("draft_user_message").$type<ZeroAgentDraftUserMessage>(),
    draftAttachments:
      jsonb("draft_attachments").$type<ZeroAgentDraftAttachments>(),
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
      draftUserMessageCheck: check(
        "zero_agent_drafts_draft_user_message_check",
        sql`${table.draftUserMessage} IS NOT NULL
          OR COALESCE(${table.draftAttachments}, '[]'::jsonb) = '[]'::jsonb`,
      ),
    };
  },
);
