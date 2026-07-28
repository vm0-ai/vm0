import {
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
    draftContent: text("draft_content"),
    draftUserMessage: jsonb(
      "draft_structured_prompt",
    ).$type<ZeroAgentDraftUserMessage>(),
    /**
     * Full structured draft content for rollout-only parts that older API
     * versions cannot decode. The legacy column remains a safe projection.
     */
    draftUserMessageWithFeedback: jsonb(
      "draft_structured_prompt_with_feedback",
    ).$type<ZeroAgentDraftUserMessage>(),
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
    };
  },
);
