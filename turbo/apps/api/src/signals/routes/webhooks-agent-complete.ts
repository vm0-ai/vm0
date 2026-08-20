import { command } from "ccstate";
import {
  webhookCompleteContract,
  webhookUsageFinalizedContract,
} from "@okouai/api-contracts/contracts/webhooks";

import { notFound } from "../../lib/error";
import { logger } from "../../lib/log";
import { apiStartTime$, authorization$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import type { RouteEntry } from "../route-entry";
import {
  completeAgentRun$,
  dispatchCompleteSideEffects$,
} from "../services/agent-webhook-complete.service";
import { acknowledgeRunUsageDelivery$ } from "../services/run-usage-finalization.service";
import { tapError } from "../utils";
import {
  getSandboxAuthForRun,
  unauthorizedRunMismatch,
} from "./agent-webhook-auth";

const L = logger("webhook:complete");

const completeBody$ = bodyResultOf(webhookCompleteContract.complete);
const usageFinalizedBody$ = bodyResultOf(
  webhookUsageFinalizedContract.finalize,
);

const completeAgentRunRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const bodyResult = await get(completeBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const body = bodyResult.data;
    const auth = getSandboxAuthForRun(body.runId, get(authorization$));
    if (!auth) {
      return unauthorizedRunMismatch;
    }

    const result = await set(completeAgentRun$, { auth, body }, signal);
    signal.throwIfAborted();

    if (result.sideEffects) {
      waitUntil(
        tapError(
          set(
            dispatchCompleteSideEffects$,
            {
              ...result.sideEffects,
              apiStartTime: get(apiStartTime$),
            },
            signal,
          ),
          (error) => {
            L.error("dispatchCompleteSideEffects failed", {
              runId: result.sideEffects?.runId,
              error,
            });
          },
        ),
      );
    }

    return {
      status: result.status,
      body: result.body,
    };
  },
);

const finalizeRunUsageRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const bodyResult = await get(usageFinalizedBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const body = bodyResult.data;
    const auth = getSandboxAuthForRun(body.runId, get(authorization$));
    if (!auth) {
      return unauthorizedRunMismatch;
    }

    const finalized = await set(
      acknowledgeRunUsageDelivery$,
      { runId: body.runId, userId: auth.userId },
      signal,
    );
    signal.throwIfAborted();
    if (finalized === null) {
      return notFound("Agent run not found");
    }
    return {
      status: 200 as const,
      body: { success: true as const, finalized },
    };
  },
);

export const webhooksAgentCompleteRoutes: readonly RouteEntry[] = [
  {
    route: webhookCompleteContract.complete,
    handler: completeAgentRunRoute$,
  },
  {
    route: webhookUsageFinalizedContract.finalize,
    handler: finalizeRunUsageRoute$,
  },
];
