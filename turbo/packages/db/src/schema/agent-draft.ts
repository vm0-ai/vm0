import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agent";
import type {
  AgentDraftAttachments,
  AgentDraftUserMessage,
  AgentDraftVoice,
} from "@okouai/db/jsonb-contracts/agent-draft";

export const agentDrafts = pgTable(
  "agent_drafts",
  {
    userId: text("user_id").notNull(),
    orgId: text("org_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    /** Canonical rich document for the agent composer's saved draft. */
    draftUserMessage:
      jsonb("draft_user_message").$type<AgentDraftUserMessage>(),
    /** Unsent voice input kept outside the canonical user message document. */
    draftVoice: jsonb("draft_voice").$type<AgentDraftVoice>(),
    draftAttachments: jsonb("draft_attachments").$type<AgentDraftAttachments>(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => {
    return {
      canonicalAgentFk: foreignKey({
        name: "agent_drafts_agent_id_agents_id_fk",
        columns: [table.agentId],
        foreignColumns: [agents.id],
      }).onDelete("cascade"),
      userOrgAgentIdx: uniqueIndex("idx_agent_drafts_user_org_agent").on(
        table.userId,
        table.orgId,
        table.agentId,
      ),
      draftUserMessageCheck: check(
        "agent_drafts_draft_user_message_check",
        sql`${table.draftUserMessage} IS NOT NULL
          OR COALESCE(${table.draftAttachments}, '[]'::jsonb) = '[]'::jsonb`,
      ),
    };
  },
);
