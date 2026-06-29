import { command } from "ccstate";
import { zeroGoalsContract } from "@vm0/api-contracts/contracts/zero-goals";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { writeDb$, type ReadonlyDb } from "../external/db";
import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { logger } from "../../lib/log";
import { settle } from "../utils";
import { dispatchFailedRunCallbacks } from "../services/agent-run-callback.service";
import { loadUserFeatureSwitchContext } from "../services/feature-switches.service";
import { bootstrapGoalRun$ } from "../services/zero-goal-continuation.service";
import {
  blockCurrentGoal,
  clearCurrentGoal,
  completeCurrentGoal,
  createGoalForCurrentThread,
  editCurrentGoal,
  getCurrentGoal,
  getGoalForChatThread,
  pauseCurrentGoal,
  pauseGoalForChatThread,
  resumeCurrentGoal,
  type GoalResult,
} from "../services/zero-goal.service";
import type { RouteEntry } from "../route-entry";
import type { AuthContext } from "../../types/auth";
import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";

const log = logger("ZeroGoals");

const goalReadAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "goal:read",
  accept: ["zero"],
} as const;

const goalAgentResultWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "goal:agent-result:write",
  accept: ["zero"],
} as const;

const goalUserControlWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "goal:user-control:write",
  accept: ["zero"],
} as const;

const sessionGoalUserControlWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "goal:user-control:write",
  accept: ["session"],
} as const;

const sessionGoalReadAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "goal:read",
  accept: ["session"],
} as const;

interface GoalAuth {
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string;
  readonly capabilities: readonly ZeroCapability[];
}

interface SessionGoalAuth {
  readonly orgId: string;
  readonly userId: string;
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
  return {
    orgId: auth.orgId,
    userId: auth.userId,
    runId: auth.runId,
    capabilities: auth.capabilities,
  };
}

function sessionGoalAuth(
  auth: AuthContext & { readonly orgId: string },
): SessionGoalAuth {
  if (auth.tokenType !== "session") {
    throw new Error("Session goal routes require session auth");
  }
  return { orgId: auth.orgId, userId: auth.userId };
}

async function goalFeatureEnabled(
  db: ReadonlyDb,
  auth: Pick<GoalAuth, "orgId" | "userId">,
): Promise<boolean> {
  const context = await loadUserFeatureSwitchContext(
    db,
    auth.orgId,
    auth.userId,
  );
  return isFeatureEnabled(FeatureSwitchKey.GoalWorkflows, context);
}

function goalErrorResponse(
  result: Exclude<GoalResult, { readonly kind: "ok" }>,
) {
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
  });
  signal.throwIfAborted();
  if (result.kind === "ok") {
    if (result.bootstrapGoal) {
      const bootstrap = await settle(
        set(
          bootstrapGoalRun$,
          {
            goal: result.bootstrapGoal,
            dispatchFailedCallbacks: dispatchFailedRunCallbacks,
          },
          signal,
        ),
        signal,
      );
      if (!bootstrap.ok) {
        log.warn("Failed to bootstrap goal run for provisioned thread", {
          goalId: result.bootstrapGoal.goalId,
          error:
            bootstrap.error instanceof Error
              ? bootstrap.error.message
              : String(bootstrap.error),
        });
      } else if (bootstrap.value.kind !== "ok") {
        log.warn("Goal bootstrap run was not enqueued", {
          goalId: result.bootstrapGoal.goalId,
          reason: bootstrap.value.kind,
        });
      }
    }
    return { status: 201 as const, body: result.goal };
  }
  return goalErrorResponse(result);
});

const editGoalBody$ = bodyResultOf(zeroGoalsContract.edit);

const editGoalInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = goalAuth(get(organizationAuthContext$));
  const bodyResult = await get(editGoalBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const db = set(writeDb$);
  if (!(await goalFeatureEnabled(db, auth))) {
    return forbidden("Goal workflows are not enabled");
  }
  signal.throwIfAborted();

  const result = await editCurrentGoal(db, {
    ...auth,
    objective: bodyResult.data.objective,
  });
  signal.throwIfAborted();
  if (result.kind === "ok") {
    return { status: 200 as const, body: result.goal };
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

const getChatThreadGoalInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = sessionGoalAuth(get(organizationAuthContext$));
    const params = get(pathParamsOf(zeroGoalsContract.getForChatThread));
    const db = set(writeDb$);
    if (!(await goalFeatureEnabled(db, auth))) {
      return forbidden("Goal workflows are not enabled");
    }
    signal.throwIfAborted();

    const result = await getGoalForChatThread(db, {
      orgId: auth.orgId,
      userId: auth.userId,
      threadId: params.threadId,
    });
    signal.throwIfAborted();
    if (result.kind === "ok") {
      return { status: 200 as const, body: result.goal };
    }
    return goalErrorResponse(result);
  },
);

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

const pauseGoalInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = goalAuth(get(organizationAuthContext$));
  const db = set(writeDb$);
  if (!(await goalFeatureEnabled(db, auth))) {
    return forbidden("Goal workflows are not enabled");
  }
  signal.throwIfAborted();

  const result = await pauseCurrentGoal(db, auth);
  signal.throwIfAborted();
  if (result.kind === "ok") {
    return { status: 200 as const, body: result.goal };
  }
  return goalErrorResponse(result);
});

const pauseChatThreadGoalInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = sessionGoalAuth(get(organizationAuthContext$));
    const params = get(pathParamsOf(zeroGoalsContract.pauseForChatThread));
    const db = set(writeDb$);
    if (!(await goalFeatureEnabled(db, auth))) {
      return forbidden("Goal workflows are not enabled");
    }
    signal.throwIfAborted();

    const result = await pauseGoalForChatThread(db, {
      orgId: auth.orgId,
      userId: auth.userId,
      threadId: params.threadId,
    });
    signal.throwIfAborted();
    if (result.kind === "ok") {
      return { status: 200 as const, body: result.goal };
    }
    return goalErrorResponse(result);
  },
);

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

const clearGoalInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = goalAuth(get(organizationAuthContext$));
  const db = set(writeDb$);
  if (!(await goalFeatureEnabled(db, auth))) {
    return forbidden("Goal workflows are not enabled");
  }
  signal.throwIfAborted();

  const result = await clearCurrentGoal(db, auth);
  signal.throwIfAborted();
  if (result.kind === "ok") {
    return { status: 200 as const, body: { cleared: true as const } };
  }
  return goalErrorResponse(result);
});

export const zeroGoalsRoutes: readonly RouteEntry[] = [
  {
    route: zeroGoalsContract.create,
    handler: authRoute(goalUserControlWriteAuth, createGoalInner$),
  },
  {
    route: zeroGoalsContract.edit,
    handler: authRoute(goalUserControlWriteAuth, editGoalInner$),
  },
  {
    route: zeroGoalsContract.get,
    handler: authRoute(goalReadAuth, getGoalInner$),
  },
  {
    route: zeroGoalsContract.getForChatThread,
    handler: authRoute(sessionGoalReadAuth, getChatThreadGoalInner$),
  },
  {
    route: zeroGoalsContract.complete,
    handler: authRoute(goalAgentResultWriteAuth, completeGoalInner$),
  },
  {
    route: zeroGoalsContract.block,
    handler: authRoute(goalAgentResultWriteAuth, blockGoalInner$),
  },
  {
    route: zeroGoalsContract.pause,
    handler: authRoute(goalUserControlWriteAuth, pauseGoalInner$),
  },
  {
    route: zeroGoalsContract.pauseForChatThread,
    handler: authRoute(
      sessionGoalUserControlWriteAuth,
      pauseChatThreadGoalInner$,
    ),
  },
  {
    route: zeroGoalsContract.resume,
    handler: authRoute(goalUserControlWriteAuth, resumeGoalInner$),
  },
  {
    route: zeroGoalsContract.clear,
    handler: authRoute(goalUserControlWriteAuth, clearGoalInner$),
  },
];
