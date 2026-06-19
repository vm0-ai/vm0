import { command } from "ccstate";
import { zeroGoalsContract } from "@vm0/api-contracts/contracts/zero-goals";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { writeDb$, type ReadonlyDb } from "../external/db";
import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { logger } from "../../lib/log";
import { settle } from "../utils";
import { dispatchFailedRunCallbacks } from "../services/agent-run-callback.service";
import { loadUserFeatureSwitchContext } from "../services/feature-switches.service";
import { bootstrapGoalRun$ } from "../services/zero-goal-continuation.service";
import {
  blockCurrentGoal,
  completeCurrentGoal,
  createGoalForCurrentThread,
  getCurrentGoal,
  resumeCurrentGoal,
  type GoalResult,
} from "../services/zero-goal.service";
import type { RouteEntry } from "../route";
import type { AuthContext } from "../../types/auth";

const log = logger("ZeroGoals");

const goalReadAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "goal:read",
  accept: ["zero"],
} as const;

const goalWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "goal:write",
  accept: ["zero"],
} as const;

interface GoalAuth {
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string;
}

function forbidden(message: string) {
  return {
    status: 403 as const,
    body: { error: { message, code: "FORBIDDEN" as const } },
  };
}

function goalAuth(auth: AuthContext & { readonly orgId: string }): GoalAuth {
  if (auth.tokenType !== "zero") {
    throw new Error("Goal routes require zero token auth");
  }
  return { orgId: auth.orgId, userId: auth.userId, runId: auth.runId };
}

async function goalFeatureEnabled(
  db: ReadonlyDb,
  auth: GoalAuth,
): Promise<boolean> {
  const context = await loadUserFeatureSwitchContext(
    db,
    auth.orgId,
    auth.userId,
  );
  return isFeatureEnabled(FeatureSwitchKey.GoalWorkflows, context);
}

function goalErrorResponse(result: GoalResult) {
  switch (result.kind) {
    case "not-found": {
      return notFound("Goal not found");
    }
    case "bad-request": {
      return badRequestMessage(result.message);
    }
    case "conflict": {
      return conflict(result.message);
    }
    default: {
      throw new Error(`Unexpected goal result: ${result.kind}`);
    }
  }
}

const createGoalBody$ = bodyResultOf(zeroGoalsContract.create);

const createGoalInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = goalAuth(get(organizationAuthContext$));
  const bodyResult = await get(createGoalBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const db = set(writeDb$);
  if (!(await goalFeatureEnabled(db, auth))) {
    return forbidden("Goal workflows are not enabled");
  }
  signal.throwIfAborted();

  const result = await createGoalForCurrentThread(db, {
    ...auth,
    objective: bodyResult.data.objective,
    ...(bodyResult.data.tokenBudget
      ? { tokenBudget: bodyResult.data.tokenBudget }
      : {}),
  });
  signal.throwIfAborted();
  if (result.kind === "ok") {
    // A freshly provisioned thread has no in-flight run to drive the first
    // goal turn, so enqueue it here. Existing threads continue from their
    // current run's terminal callback. Best-effort: a failed first enqueue
    // must not roll back the created goal, which can still be resumed later.
    if (result.bootstrapTrigger) {
      const bootstrap = await settle(
        set(
          bootstrapGoalRun$,
          {
            trigger: result.bootstrapTrigger,
            dispatchFailedCallbacks: dispatchFailedRunCallbacks,
          },
          signal,
        ),
        signal,
      );
      if (!bootstrap.ok) {
        log.warn("Failed to bootstrap goal run for provisioned thread", {
          triggerId: result.bootstrapTrigger.id,
          error:
            bootstrap.error instanceof Error
              ? bootstrap.error.message
              : String(bootstrap.error),
        });
      } else if (bootstrap.value.kind !== "ok") {
        log.warn("Goal bootstrap run was not enqueued", {
          triggerId: result.bootstrapTrigger.id,
          reason: bootstrap.value.kind,
        });
      }
    }
    return { status: 201 as const, body: result.goal };
  }
  return goalErrorResponse(result);
});

const getGoalInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = goalAuth(get(organizationAuthContext$));
  const db = set(writeDb$);
  if (!(await goalFeatureEnabled(db, auth))) {
    return forbidden("Goal workflows are not enabled");
  }
  signal.throwIfAborted();

  const result = await getCurrentGoal(db, auth);
  signal.throwIfAborted();
  if (result.kind === "ok") {
    return { status: 200 as const, body: result.goal };
  }
  return goalErrorResponse(result);
});

const completeGoalInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = goalAuth(get(organizationAuthContext$));
    const db = set(writeDb$);
    if (!(await goalFeatureEnabled(db, auth))) {
      return forbidden("Goal workflows are not enabled");
    }
    signal.throwIfAborted();

    const result = await completeCurrentGoal(db, auth);
    signal.throwIfAborted();
    if (result.kind === "ok") {
      return { status: 200 as const, body: result.goal };
    }
    return goalErrorResponse(result);
  },
);

const blockGoalInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = goalAuth(get(organizationAuthContext$));
  const db = set(writeDb$);
  if (!(await goalFeatureEnabled(db, auth))) {
    return forbidden("Goal workflows are not enabled");
  }
  signal.throwIfAborted();

  const result = await blockCurrentGoal(db, auth);
  signal.throwIfAborted();
  if (result.kind === "ok") {
    return { status: 200 as const, body: result.goal };
  }
  return goalErrorResponse(result);
});

const resumeGoalInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = goalAuth(get(organizationAuthContext$));
  const db = set(writeDb$);
  if (!(await goalFeatureEnabled(db, auth))) {
    return forbidden("Goal workflows are not enabled");
  }
  signal.throwIfAborted();

  const result = await resumeCurrentGoal(db, auth);
  signal.throwIfAborted();
  if (result.kind === "ok") {
    return { status: 200 as const, body: result.goal };
  }
  return goalErrorResponse(result);
});

export const zeroGoalsRoutes: readonly RouteEntry[] = [
  {
    route: zeroGoalsContract.create,
    handler: authRoute(goalWriteAuth, createGoalInner$),
  },
  {
    route: zeroGoalsContract.get,
    handler: authRoute(goalReadAuth, getGoalInner$),
  },
  {
    route: zeroGoalsContract.complete,
    handler: authRoute(goalWriteAuth, completeGoalInner$),
  },
  {
    route: zeroGoalsContract.block,
    handler: authRoute(goalWriteAuth, blockGoalInner$),
  },
  {
    route: zeroGoalsContract.resume,
    handler: authRoute(goalWriteAuth, resumeGoalInner$),
  },
];
