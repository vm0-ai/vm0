import { command } from "ccstate";
import {
  webhookCheckpointsContract,
  webhookCheckpointsPrepareHistoryContract,
} from "@vm0/api-contracts/contracts/webhooks";

import { notFound } from "../../lib/error";
import { authorization$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route";
import {
  createAgentCheckpoint$,
  prepareCheckpointHistoryUpload$,
} from "../services/agent-webhook-checkpoints.service";
import { settle } from "../utils";
import {
  getSandboxAuthForRun,
  unauthorizedRunMismatch,
} from "./agent-webhook-auth";

const PG_FOREIGN_KEY_VIOLATION = "23503";

function isForeignKeyViolation(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const { cause } = error;
  if (typeof cause !== "object" || cause === null || !("code" in cause)) {
    return false;
  }

  return cause.code === PG_FOREIGN_KEY_VIOLATION;
}

const createBody$ = bodyResultOf(webhookCheckpointsContract.create);
const createCheckpoint$ = command(async ({ get, set }, signal: AbortSignal) => {
  const bodyResult = await get(createBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const body = bodyResult.data;
  const auth = getSandboxAuthForRun(body.runId, get(authorization$));
  if (!auth) {
    return unauthorizedRunMismatch;
  }

  const result = await settle(
    set(createAgentCheckpoint$, { auth, body }, signal),
  );
  signal.throwIfAborted();

  if (!result.ok) {
    if (isForeignKeyViolation(result.error)) {
      return notFound("Agent run not found");
    }
    throw result.error;
  }

  return result.value;
});

const prepareHistoryBody$ = bodyResultOf(
  webhookCheckpointsPrepareHistoryContract.prepare,
);
const prepareHistory$ = command(async ({ get, set }, signal: AbortSignal) => {
  const bodyResult = await get(prepareHistoryBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const body = bodyResult.data;
  const auth = getSandboxAuthForRun(body.runId, get(authorization$));
  if (!auth) {
    return unauthorizedRunMismatch;
  }

  return await set(prepareCheckpointHistoryUpload$, { auth, body }, signal);
});

export const webhooksAgentCheckpointsRoutes: readonly RouteEntry[] = [
  {
    route: webhookCheckpointsContract.create,
    handler: createCheckpoint$,
  },
  {
    route: webhookCheckpointsPrepareHistoryContract.prepare,
    handler: prepareHistory$,
  },
];
