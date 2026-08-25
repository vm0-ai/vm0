import type {
  AgentDraftAttachments,
  AgentDraftUserMessage,
} from "@okouai/db/jsonb-contracts/agent-draft";
import { agentDrafts } from "@okouai/db/schema/agent-draft";
import { and, eq } from "drizzle-orm";

import type { ApiDb } from "../../lib/db-types";
import { isUniqueViolation } from "../../lib/pg-errors";
import { settle } from "../utils";

const MAX_AGENT_DRAFT_WRITE_ATTEMPTS = 2;

export interface AgentDraftWrite {
  readonly userId: string;
  readonly orgId: string;
  readonly agentId: string;
  readonly draftUserMessage: AgentDraftUserMessage | null;
  readonly draftAttachments: AgentDraftAttachments | null;
  readonly updatedAt: Date;
}

export async function persistAgentDraft(
  db: ApiDb,
  draft: AgentDraftWrite,
): Promise<void> {
  const keyPredicate = and(
    eq(agentDrafts.userId, draft.userId),
    eq(agentDrafts.orgId, draft.orgId),
    eq(agentDrafts.agentId, draft.agentId),
  );
  if (
    !draft.draftUserMessage &&
    !(draft.draftAttachments && draft.draftAttachments.length > 0)
  ) {
    await db.delete(agentDrafts).where(keyPredicate);
    return;
  }

  const update = {
    draftUserMessage: draft.draftUserMessage,
    draftAttachments: draft.draftAttachments,
    updatedAt: draft.updatedAt,
  };

  for (
    let attempt = 0;
    attempt < MAX_AGENT_DRAFT_WRITE_ATTEMPTS;
    attempt += 1
  ) {
    const updated = await db
      .update(agentDrafts)
      .set(update)
      .where(keyPredicate)
      .returning({ agentId: agentDrafts.agentId });
    if (updated.length > 0) {
      return;
    }

    const inserted = await settle(
      db.insert(agentDrafts).values({
        userId: draft.userId,
        orgId: draft.orgId,
        agentId: draft.agentId,
        ...update,
      }),
    );
    if (inserted.ok) {
      return;
    }
    if (
      !isUniqueViolation(inserted.error) ||
      attempt === MAX_AGENT_DRAFT_WRITE_ATTEMPTS - 1
    ) {
      throw inserted.error;
    }
    // Retry the full cycle in case the competing row is deleted first.
  }
}
