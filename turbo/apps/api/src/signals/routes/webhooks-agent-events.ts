import { command } from "ccstate";
import { webhookEventsContract } from "@vm0/api-contracts/contracts/webhooks";

import { eventDeliveryUnavailable } from "../../lib/error";
import { authorization$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import type { RouteEntry } from "../route-entry";
import { awaitWithSignal, settleIncludingAbort } from "../utils";
import {
  dispatchOptionalAgentEventConsumers$,
  receiveAgentEvents$,
} from "../services/agent-webhook-events.service";
import {
  getSandboxAuthForRun,
  unauthorizedRunMismatch,
} from "./agent-webhook-auth";

const EVENT_ROUTE_TIMEOUT_MS = 20_000;
const eventsBody$ = bodyResultOf(webhookEventsContract.send);

const receiveEvents$ = command(async ({ get, set }, signal: AbortSignal) => {
  const deadlineSignal = AbortSignal.timeout(EVENT_ROUTE_TIMEOUT_MS);
  const routeSignal = AbortSignal.any([signal, deadlineSignal]);
  const operation = (async () => {
    const bodyResult = await get(eventsBody$);
    routeSignal.throwIfAborted();
    if (!bodyResult.ok) {
      return { response: bodyResult.response };
    }

    const body = bodyResult.data;
    const auth = getSandboxAuthForRun(body.runId, get(authorization$));
    if (!auth) {
      return { response: unauthorizedRunMismatch };
    }

    return await set(receiveAgentEvents$, { auth, body }, routeSignal);
  })();

  const deadlineResult = await settleIncludingAbort(
    awaitWithSignal(operation, deadlineSignal),
  );
  signal.throwIfAborted();
  if (!deadlineResult.ok) {
    if (!deadlineSignal.aborted) {
      throw deadlineResult.error;
    }
    return eventDeliveryUnavailable(
      "Agent event delivery exceeded its response deadline",
    );
  }

  const result = deadlineResult.value;
  if ("acceptedEvents" in result && result.acceptedEvents !== undefined) {
    waitUntil(
      set(dispatchOptionalAgentEventConsumers$, result.acceptedEvents, signal),
    );
  }
  return result.response;
});

export const webhooksAgentEventsRoutes: readonly RouteEntry[] = [
  {
    route: webhookEventsContract.send,
    handler: receiveEvents$,
  },
];
