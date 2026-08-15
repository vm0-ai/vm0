import type { CodexServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import { agentRuns } from "@okouai/db/schema/agent-run";
import { and, eq, isNotNull } from "drizzle-orm";

import type { ReadonlyDb } from "../external/db";

interface ZeroRunModelSelection {
  readonly selectedModel: string | null;
  readonly codexServiceTier: CodexServiceTier | null;
}

export async function resolveZeroRunModelSelection(
  db: ReadonlyDb,
  runId: string,
): Promise<ZeroRunModelSelection | undefined> {
  const [row] = await db
    .select({
      selectedModel: agentRuns.selectedModel,
      codexServiceTier: agentRuns.codexServiceTier,
    })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), isNotNull(agentRuns.triggerSource)))
    .limit(1);
  return row;
}
