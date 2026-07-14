import { cronExecuteWorkflowAutomationsContract } from "@vm0/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route-entry";
import { executeDueNotionWorkflowEvents$ } from "../services/notion-workflow-event.service";
import { executeDueWorkflowAutomations$ } from "../services/zero-workflow-automation-poller.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

// The cron tick polls the zero_workflow_automations table; runs carry generic
// trigger provenance and inject the workflow skill via the agent's attachment.
const executeWorkflowAutomationsRoute$: RouteEntry["handler"] = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const result = await set(executeDueWorkflowAutomations$, signal);
    const notionResult = await set(executeDueNotionWorkflowEvents$, signal);
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        success: true as const,
        executed: result.executed + notionResult.executed,
        skipped: result.skipped + notionResult.skipped,
      },
    };
  },
);

export const cronExecuteWorkflowAutomationsRoutes: readonly RouteEntry[] = [
  {
    route: cronExecuteWorkflowAutomationsContract.execute,
    handler: executeWorkflowAutomationsRoute$,
  },
];
