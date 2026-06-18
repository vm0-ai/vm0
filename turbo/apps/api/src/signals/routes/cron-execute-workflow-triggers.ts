import { cronExecuteWorkflowTriggersContract } from "@vm0/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route";
import { executeDueWorkflowTriggers$ } from "../services/zero-workflow-trigger-poller.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

// The cron tick polls the zero_workflow_triggers table; runs carry
// workflow_trigger_id provenance and inject the workflow skill via the agent's
// attachment.
const executeWorkflowTriggersRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const result = await set(executeDueWorkflowTriggers$, signal);
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        success: true as const,
        executed: result.executed,
        skipped: result.skipped,
      },
    };
  },
);

export const cronExecuteWorkflowTriggersRoutes: readonly RouteEntry[] = [
  {
    route: cronExecuteWorkflowTriggersContract.execute,
    handler: executeWorkflowTriggersRoute$,
  },
];
