import { command } from "ccstate";
import { runsCancelContract } from "@vm0/api-contracts/contracts/runs";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { and, eq } from "drizzle-orm";

import { authContext$, type AuthErrorResponse } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { waitUntil } from "../context/wait-until";
import { writeDb$ } from "../external/db";
import { badRequestMessage, isNotFoundResponse } from "../../lib/error";
import { logger } from "../../lib/log";
import {
  cancelRun$,
  dispatchCancelSideEffects$,
} from "../services/zero-run-cancel.service";
import type { RouteEntry } from "../route";

const L = logger("AgentRunsCancel");

function missingOrg(): AuthErrorResponse {
  return {
    status: 401,
    body: {
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    },
  };
}

function sandboxRunNotFound() {
  return {
    status: 404 as const,
    body: {
      error: { message: "Agent run not found", code: "NOT_FOUND" },
    },
  };
}

const cancelRunInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(authContext$);
  const params = get(pathParamsOf(runsCancelContract.cancel));
  const db = set(writeDb$);

  let orgId: string | undefined;
  if (auth.tokenType === "sandbox") {
    const [sandboxRun] = await db
      .select({ orgId: agentRuns.orgId })
      .from(agentRuns)
      .where(
        and(eq(agentRuns.id, auth.runId), eq(agentRuns.userId, auth.userId)),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!sandboxRun) {
      return sandboxRunNotFound();
    }
    orgId = sandboxRun.orgId;
  } else {
    orgId = auth.orgId;
  }

  if (!orgId) {
    return missingOrg();
  }

  const result = await set(
    cancelRun$,
    { runId: params.id, userId: auth.userId, orgId },
    signal,
  );
  signal.throwIfAborted();

  if ("status" in result) {
    if (isNotFoundResponse(result)) {
      return {
        status: 404 as const,
        body: {
          error: { message: result.body.error.message, code: "NOT_FOUND" },
        },
      };
    }
    return result.status === 400
      ? result
      : badRequestMessage("Unable to cancel run");
  }

  if (!result.alreadyCancelled) {
    waitUntil(
      set(dispatchCancelSideEffects$, result, signal).catch(
        (error: unknown) => {
          L.error("dispatchCancelSideEffects failed", {
            runId: result.runId,
            error,
          });
        },
      ),
    );
  }

  return {
    status: 200 as const,
    body: {
      id: params.id,
      status: "cancelled" as const,
      message: "Run cancelled successfully",
    },
  };
});

export const agentRunsCancelRoutes: readonly RouteEntry[] = [
  {
    route: runsCancelContract.cancel,
    handler: authRoute(
      {
        acceptAnySandboxCapability: true,
      },
      cancelRunInner$,
    ),
  },
];
