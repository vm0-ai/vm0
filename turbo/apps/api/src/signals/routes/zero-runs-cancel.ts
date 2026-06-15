import { command } from "ccstate";
import { zeroRunsCancelContract } from "@vm0/api-contracts/contracts/zero-runs";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import { logger } from "../../lib/log";
import {
  cancelRun$,
  dispatchCancelSideEffects$,
  type CancelRunResult,
} from "../services/zero-run-cancel.service";
import { tapError } from "../utils";
import type { RouteEntry } from "../route";

const L = logger("RunCancel");

function isCancelResult(value: NonNullable<unknown>): value is CancelRunResult {
  return "alreadyCancelled" in value;
}

const cancelInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(pathParamsOf(zeroRunsCancelContract.cancel));
  signal.throwIfAborted();

  const result = await set(
    cancelRun$,
    { runId: params.id, userId: auth.userId, orgId: auth.orgId },
    signal,
  );
  signal.throwIfAborted();

  if (!isCancelResult(result)) {
    // Frozen httpError response from notFound() or runNotCancellable() —
    // forward verbatim. The body.error.code differentiates 404 NOT_FOUND
    // from 400 RUN_NOT_CANCELLABLE for the client.
    return result;
  }

  if (!result.alreadyCancelled) {
    waitUntil(
      tapError(set(dispatchCancelSideEffects$, result, signal), (error) => {
        L.error("dispatchCancelSideEffects failed", {
          runId: result.runId,
          error,
        });
      }),
    );
  }

  return {
    status: 200 as const,
    body: {
      id: result.runId,
      status: "cancelled" as const,
      message: "Run cancelled successfully",
    },
  };
});

export const zeroRunsCancelRoutes: readonly RouteEntry[] = [
  {
    route: zeroRunsCancelContract.cancel,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "agent-run:write",
      },
      cancelInner$,
    ),
  },
];
