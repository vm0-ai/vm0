import {
  AGENT_EXECUTION_TIMEOUT_SECONDS,
  CANCELLATION_RECOVERY_STALE_AFTER_MS,
} from "@okouai/api-contracts/contracts/runners";
import { agentRuns } from "@okouai/db/schema/agent-run";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { and, eq, isNull } from "drizzle-orm";

import type { Db } from "../external/db";
import { piMemoryPhase2MaintenanceCallbackPayloadSchema } from "./pi-memory-phase2-maintenance.service";

export const PI_MEMORY_PHASE2_MODEL = "gpt-5.6-terra";

// A terminal callback can precede the runner's final proxy flush. Keep the
// private binding for a full runner lifetime plus finalization, including
// retained webhook retries, instead of the ordinary two-minute quiet window.
export const PI_MEMORY_PHASE2_USAGE_DRAIN_MS =
  AGENT_EXECUTION_TIMEOUT_SECONDS * 1000 + CANCELLATION_RECOVERY_STALE_AFTER_MS;

/**
 * Identify private Phase 2 runs whose bindings must survive late proxy usage.
 * Use the dispatched immutable binding, not a mutable job lease:
 * failed/revoked attempts still cost.
 */
export async function loadPiMemoryPhase2UsageBinding(
  db: Pick<Db, "select">,
  scope: {
    readonly runId: string;
    readonly orgId: string;
    readonly userId: string;
  },
) {
  const [context] = await db
    .select({
      launchSnapshot: agentRuns.launchSnapshot,
      payload: agentRunCallbacks.payload,
    })
    .from(agentRuns)
    .innerJoin(
      agentRunCallbacks,
      and(
        eq(agentRunCallbacks.runId, agentRuns.id),
        eq(agentRunCallbacks.internalKind, "pi-memory:phase2"),
      ),
    )
    .where(
      and(
        eq(agentRuns.id, scope.runId),
        eq(agentRuns.orgId, scope.orgId),
        eq(agentRuns.userId, scope.userId),
        eq(agentRuns.triggerSource, "agent"),
        isNull(agentRuns.chatThreadId),
        eq(agentRuns.modelProvider, "built-in"),
        eq(agentRuns.selectedModel, PI_MEMORY_PHASE2_MODEL),
      ),
    )
    .limit(1);
  const binding = piMemoryPhase2MaintenanceCallbackPayloadSchema.safeParse(
    context?.payload,
  );
  if (
    context?.launchSnapshot?.framework !== "pi" ||
    !binding.success ||
    binding.data.orgId !== scope.orgId ||
    binding.data.userId !== scope.userId
  ) {
    return undefined;
  }
  return binding.data;
}
