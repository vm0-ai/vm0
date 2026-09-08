import { command } from "ccstate";
import { webhookCompleteContract } from "@okouai/api-contracts/contracts/webhooks";

import { eventDeliveryUnavailable, notFound } from "../../lib/error";
import { logger } from "../../lib/log";
import { apiStartTime$, authorization$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import type { RouteEntry } from "../route-entry";
import {
  completeAgentRun$,
  type DispatchCompleteSideEffectsInput,
} from "../services/agent-webhook-complete.service";
import {
  AgentEventRunNotFoundError,
  finalizeLegacyPiRunOutput$,
} from "../services/agent-event-consumer-run-output.service";
import {
  dispatchOptionalAgentEventConsumers$,
  type AcceptedAgentEvents,
} from "../services/agent-webhook-events.service";
import { dispatchCompleteSideEffects$ } from "../services/agent-run-lifecycle.service";
import { settle, tapError } from "../utils";
import {
  getSandboxAuthForRun,
  unauthorizedRunMismatch,
} from "./agent-webhook-auth";

const L = logger("webhook:complete");

const completeBody$ = bodyResultOf(webhookCompleteContract.complete);

const dispatchCompletionRouteSideEffects$ = command(
  async (
    { set },
    input: {
      readonly acceptedEvents?: AcceptedAgentEvents;
      readonly completion?: DispatchCompleteSideEffectsInput;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    if (input.acceptedEvents) {
      await set(
        dispatchOptionalAgentEventConsumers$,
        input.acceptedEvents,
        signal,
      );
      signal.throwIfAborted();
    }
    if (input.completion) {
      await set(dispatchCompleteSideEffects$, input.completion, signal);
    }
  },
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

    let acceptedEvents: AcceptedAgentEvents | undefined;
    if (body.lastEventSequence !== undefined) {
      const finalization = await settle(
        set(
          finalizeLegacyPiRunOutput$,
          {
            runId: body.runId,
            context: { userId: auth.userId, orgId: auth.orgId },
            lastEventSequence: body.lastEventSequence,
          },
          signal,
        ),
      );
      signal.throwIfAborted();
      if (!finalization.ok) {
        if (finalization.error instanceof AgentEventRunNotFoundError) {
          return notFound("Agent run not found");
        }
        L.error("Required legacy Pi output finalization failed", {
          runId: body.runId,
          lastEventSequence: body.lastEventSequence,
          error: finalization.error,
        });
        return eventDeliveryUnavailable(
          "Agent output finalization is temporarily unavailable",
        );
      }
      if (
        finalization.value?.outcome === "accepted" &&
        finalization.value.payload.events.length > 0
      ) {
        acceptedEvents = {
          payload: finalization.value.payload,
          chatProjection: finalization.value.chatProjection,
        };
      }
    }

    const result = await set(completeAgentRun$, { auth, body }, signal);
    signal.throwIfAborted();

    if (result.status === 200 && (acceptedEvents || result.sideEffects)) {
      waitUntil(
        tapError(
          set(
            dispatchCompletionRouteSideEffects$,
            {
              ...(acceptedEvents ? { acceptedEvents } : {}),
              ...(result.sideEffects
                ? {
                    completion: {
                      ...result.sideEffects,
                      apiStartTime: get(apiStartTime$),
                    },
                  }
                : {}),
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

export const webhooksAgentCompleteRoutes: readonly RouteEntry[] = [
  {
    route: webhookCompleteContract.complete,
    handler: completeAgentRunRoute$,
  },
];
