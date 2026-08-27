import { testWorkflowAutomationExecutionContract } from "@okouai/api-contracts/contracts/test-workflow-automation-execution";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";

import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { nowDate } from "../../lib/time";
import type { RouteEntry } from "../route-entry";
import { dispatchRunCallbacks } from "../services/agent-run-callback.service";
import { handleWorkflowAutomationResultEmailInternalCallback } from "../services/internal-workflow-automation-result-email-callback.service";
import { executeDueNotionAutomationEventsForAutomation$ } from "../services/notion-automation-event.service";
import { executeDueStrapiAutomationEventsForAutomation$ } from "../services/strapi-automation-event.service";
import { executeDueStripeAutomationEventsForAutomation$ } from "../services/stripe-automation-event.service";
import { executeDueWorkflowAutomationsForAutomation$ } from "../services/workflow-automation-poller.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

const body$ = bodyResultOf(testWorkflowAutomationExecutionContract.execute);
const dispatchBody$ = bodyResultOf(
  testWorkflowAutomationExecutionContract.dispatchCallbacks,
);
const interruptionBody$ = bodyResultOf(
  testWorkflowAutomationExecutionContract.interruptResultEmailCallback,
);

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

const dispatchTestWorkflowAutomationCallbacks$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const bodyResult = await get(dispatchBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const body = bodyResult.data;
    const db = set(writeDb$);
    const dispatches = await Promise.all(
      Array.from({ length: body.dispatch_count }, async () => {
        return await dispatchRunCallbacks(
          db,
          body.run_id,
          body.status,
          undefined,
          body.status === "failed" ? body.error : undefined,
        );
      }),
    );
    signal.throwIfAborted();
    const callbackResults = dispatches.flat();
    return {
      status: 200 as const,
      body: {
        success: true as const,
        dispatches: dispatches.length,
        callback_results: callbackResults.length,
        successful_callbacks: callbackResults.filter((result) => {
          return result.success;
        }).length,
      },
    };
  },
);

const interruptTestWorkflowAutomationResultEmailCallback$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const bodyResult = await get(interruptionBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const db = set(writeDb$);
    const [callback] = await db
      .select({
        id: agentRunCallbacks.id,
        payload: agentRunCallbacks.payload,
      })
      .from(agentRunCallbacks)
      .where(
        and(
          eq(agentRunCallbacks.runId, bodyResult.data.run_id),
          eq(
            agentRunCallbacks.internalKind,
            "workflow-automation:result-email",
          ),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!callback) {
      throw new Error("Official Automation result email callback not found");
    }

    await db
      .update(agentRunCallbacks)
      .set({ attempts: 1, lastAttemptAt: nowDate() })
      .where(eq(agentRunCallbacks.id, callback.id));
    signal.throwIfAborted();
    const result = await handleWorkflowAutomationResultEmailInternalCallback(
      db,
      {
        callbackId: callback.id,
        runId: bodyResult.data.run_id,
        status: "completed",
        payload: callback.payload,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!result.success) {
      throw new Error(result.error);
    }
    return {
      status: 200 as const,
      body: {
        success: true as const,
        callback_id: callback.id,
        skipped: result.skipped ?? false,
      },
    };
  },
);

export const testWorkflowAutomationExecutionRoutes: readonly RouteEntry[] = [
  {
    route: testWorkflowAutomationExecutionContract.execute,
    handler: executeTestWorkflowAutomation$,
  },
  {
    route: testWorkflowAutomationExecutionContract.dispatchCallbacks,
    handler: dispatchTestWorkflowAutomationCallbacks$,
  },
  {
    route: testWorkflowAutomationExecutionContract.interruptResultEmailCallback,
    handler: interruptTestWorkflowAutomationResultEmailCallback$,
  },
];
