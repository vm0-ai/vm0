import { command } from "ccstate";
import { webhookEventsContract } from "@vm0/api-contracts/contracts/webhooks";

import { authorization$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route";
import { receiveAgentEvents$ } from "../services/agent-webhook-events.service";
import {
  getSandboxAuthForRun,
  unauthorizedRunMismatch,
} from "./agent-webhook-auth";

const eventsBody$ = bodyResultOf(webhookEventsContract.send);

const receiveEvents$ = command(async ({ get, set }, signal: AbortSignal) => {
  const bodyResult = await get(eventsBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const body = bodyResult.data;
  const auth = getSandboxAuthForRun(body.runId, get(authorization$));
  if (!auth) {
    return unauthorizedRunMismatch;
  }

  return await set(receiveAgentEvents$, { auth, body }, signal);
});

export const webhooksAgentEventsRoutes: readonly RouteEntry[] = [
  {
    route: webhookEventsContract.send,
    handler: receiveEvents$,
  },
];
