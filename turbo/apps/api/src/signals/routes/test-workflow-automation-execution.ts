import { testWorkflowAutomationExecutionContract } from "@vm0/api-contracts/contracts/test-workflow-automation-execution";
import { command } from "ccstate";

import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { executeDueNotionAutomationEventsForAutomation$ } from "../services/notion-automation-event.service";
import { executeDueStrapiAutomationEventsForAutomation$ } from "../services/strapi-automation-event.service";
import { executeDueStripeAutomationEventsForAutomation$ } from "../services/stripe-automation-event.service";
import { executeDueWorkflowAutomationsForAutomation$ } from "../services/zero-workflow-automation-poller.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

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
      executeDueNotionAutomationEventsForAutomation$,
      automationId,
      signal,
    );
    const strapi = await set(
      executeDueStrapiAutomationEventsForAutomation$,
      automationId,
      signal,
    );
    const stripe = await set(
      executeDueStripeAutomationEventsForAutomation$,
      automationId,
      signal,
    );
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        success: true as const,
        executed:
          scheduled.executed +
          notion.executed +
          strapi.executed +
          stripe.executed,
        skipped:
          scheduled.skipped +
          notion.skipped +
          strapi.skipped +
          stripe.skipped +
          stripe.failed +
          stripe.retried,
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
