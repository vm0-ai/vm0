import { usageEvent } from "@okouai/db/schema/usage-event";
import { agentRuns } from "@okouai/db/schema/agent-run";
import { command } from "ccstate";
import { eq } from "drizzle-orm";

import { writeDb$ } from "../external/db";
import { processOrgUsageEvents$ } from "./credit-usage.service";
import { finalizeRunUsage$ } from "./run-usage-finalization.service";

export const processStaleUsageEvents$ = command(
  async ({ set }, signal: AbortSignal): Promise<number> => {
    const db = set(writeDb$);
    const orgs = await db
      .selectDistinct({ orgId: usageEvent.orgId })
      .from(usageEvent)
      .where(eq(usageEvent.status, "pending"));
    signal.throwIfAborted();

    for (const { orgId } of orgs) {
      await set(processOrgUsageEvents$, orgId, signal);
      signal.throwIfAborted();
    }

    const finalizationCandidates = await db
      .select({ runId: agentRuns.id })
      .from(agentRuns)
      .where(eq(agentRuns.usageFinalizationState, "deliveryFinalized"));
    signal.throwIfAborted();
    for (const { runId } of finalizationCandidates) {
      await set(finalizeRunUsage$, runId, signal);
      signal.throwIfAborted();
    }

    return orgs.length;
  },
);
