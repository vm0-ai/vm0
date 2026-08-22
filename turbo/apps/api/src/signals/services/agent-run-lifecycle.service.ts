import { command } from "ccstate";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { now } from "../../lib/time";
import { deleteS3Objects } from "../external/s3";
import { tapError } from "../utils";
import { activatePendingRun$ } from "./agent-run-activation.service";
import {
  dispatchCompleteSideEffectsCore$,
  type DispatchCompleteSideEffectsInput,
} from "./agent-webhook-complete.service";
import { piApiFirstTurnObjectKey } from "./pi-api-first-turn-config";
import { promoteNextQueuedRun$, staleQueueOrgIds$ } from "./run-queue.service";

const L = logger("RunLifecycle");

/** Promote one queued run and finish its commit-owned activation. */
export const drainOrgQueue$ = command(
  async (
    { set },
    args: { readonly orgId: string },
    signal: AbortSignal,
  ): Promise<number> => {
    const activation = await set(promoteNextQueuedRun$, args, signal);
    if (signal.aborted) {
      L.debug("Request aborted after queued run promotion commit", {
        runId: activation?.runnerNotification.runId,
        orgId: args.orgId,
      });
    }
    if (!activation) {
      signal.throwIfAborted();
      return 0;
    }
    const activationScheduledAt = now();
    await tapError(
      set(activatePendingRun$, { activation, activationScheduledAt }),
      (error) => {
        L.error("Failed to activate promoted queued run", {
          runId: activation.runnerNotification.runId,
          orgId: args.orgId,
          error,
        });
      },
    );
    if (signal.aborted) {
      L.debug("Request aborted after queued run activation", {
        runId: activation.runnerNotification.runId,
        orgId: args.orgId,
      });
    }
    return 1;
  },
);

export const drainOrgQueueToCapacity$ = command(
  async (
    { set },
    args: { readonly orgId: string },
    signal: AbortSignal,
  ): Promise<number> => {
    let drained = 0;
    while (true) {
      const promoted = await set(drainOrgQueue$, args, signal);
      signal.throwIfAborted();
      if (promoted === 0) {
        return drained;
      }
      drained += promoted;
    }
  },
);

export const drainStaleQueues$ = command(
  async (
    { set },
    orgIds: readonly string[] | null,
    signal: AbortSignal,
  ): Promise<number> => {
    const staleOrgIds = await set(staleQueueOrgIds$, orgIds, signal);
    signal.throwIfAborted();
    let drained = 0;
    for (const orgId of staleOrgIds) {
      L.debug("Draining stale queue", { orgId });
      drained += await set(drainOrgQueue$, { orgId }, signal);
      signal.throwIfAborted();
    }
    return drained;
  },
);

/** Dispatch terminal effects, clean staging data, and release the org slot. */
export const dispatchCompleteSideEffects$ = command(
  async (
    { get, set },
    input: DispatchCompleteSideEffectsInput,
    signal: AbortSignal,
  ): Promise<void> => {
    await set(dispatchCompleteSideEffectsCore$, input, signal);
    signal.throwIfAborted();
    if (input.cleanupPiApiFirstTurn) {
      await tapError(
        get(
          deleteS3Objects(env("R2_USER_STORAGES_BUCKET_NAME"), [
            piApiFirstTurnObjectKey(input.runId, "manifest"),
            piApiFirstTurnObjectKey(input.runId, "session"),
          ]),
        ),
        (error) => {
          L.warn("Failed to release Pi API first-turn staging objects", {
            runId: input.runId,
            error,
          });
        },
      );
      signal.throwIfAborted();
    }
    if (input.kind !== "terminal") {
      return;
    }
    await tapError(
      set(drainOrgQueue$, { orgId: input.orgId }, signal),
      (error) => {
        L.error("Failed to drain org queue", {
          runId: input.runId,
          orgId: input.orgId,
          error,
        });
      },
    );
    signal.throwIfAborted();
  },
);
