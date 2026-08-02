import { testWorkflowAutomationExecutionContract } from "@vm0/api-contracts/contracts/test-workflow-automation-execution";
import { command } from "ccstate";

import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { executeDueNotionWorkflowEventsForAutomation$ } from "../services/notion-workflow-event.service";
import { executeDueStrapiWorkflowEventsForAutomation$ } from "../services/strapi-workflow-event.service";
import { executeDueWorkflowAutomationsForAutomation$ } from "../services/zero-workflow-automation-poller.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

const body$ = bodyResultOf(testWorkflowAutomationExecutionContract.execute);

const executeTestWorkflowAutomation$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const bodyResult = await get(body$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const automationId = bodyResult.data.automation_id;
    const scheduled = await set(
      executeDueWorkflowAutomationsForAutomation$,
      automationId,
      signal,
    );
    const notion = await set(
      executeDueNotionWorkflowEventsForAutomation$,
      automationId,
      signal,
    );
    const strapi = await set(
      executeDueStrapiWorkflowEventsForAutomation$,
      automationId,
      signal,
    );
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        success: true as const,
        executed: scheduled.executed + notion.executed + strapi.executed,
        skipped: scheduled.skipped + notion.skipped + strapi.skipped,
      },
    };
  },
);

export const testWorkflowAutomationExecutionRoutes: readonly RouteEntry[] = [
  {
    route: testWorkflowAutomationExecutionContract.execute,
    handler: executeTestWorkflowAutomation$,
  },
];
