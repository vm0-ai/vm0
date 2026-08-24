import { command } from "ccstate";
import { goalsContract } from "@okouai/api-contracts/contracts/goals";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { writeDb$ } from "../external/db";
import {
  autonomyBudgetExhausted,
  badRequestMessage,
  conflict,
  notFound,
} from "../../lib/error";
import { logger } from "../../lib/log";
import { tapError } from "../utils";
import { dispatchFailedRunCallbacks } from "../services/agent-run-callback.service";
import { bootstrapGoalRun$ } from "../services/goal-continuation.service";
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
} from "../services/goal.service";
import type { RouteEntry } from "../route-entry";
import type { AuthContext } from "../../types/auth";
import type { Capability } from "@okouai/api-contracts/contracts/capabilities";

const log = logger("Goals");

const goalReadAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "goal:read",
  accept: ["agent"],
} as const;

const goalAgentResultWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "goal:agent-result:write",
  accept: ["agent"],
} as const;

const goalUserControlWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "goal:user-control:write",
  accept: ["agent"],
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
  readonly capabilities: readonly Capability[];
}

interface SessionGoalAuth {
  readonly orgId: string;
  readonly userId: string;
}

function goalAuth(auth: AuthContext & { readonly orgId: string }): GoalAuth {
  if (auth.tokenType !== "agent") {
    throw new Error("Goal routes require agent token auth");
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
    case "autonomy-budget-exhausted": {
      return autonomyBudgetExhausted();
    }
  }
}

const createGoalBody$ = bodyResultOf(goalsContract.create);

const createGoalInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = goalAuth(get(organizationAuthContext$));
  const bodyResult = await get(createGoalBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const db = set(writeDb$);
  const result = await createGoalForCurrentThread(db, {
    ...auth,
    objective: bodyResult.data.objective,
  });
  signal.throwIfAborted();
  if (result.kind === "ok") {
    const bootstrapGoal = result.bootstrapGoal;
    if (bootstrapGoal) {
      const bootstrap = await tapError(
        set(
          bootstrapGoalRun$,
          {
            db,
            goal: bootstrapGoal,
            dispatchFailedCallbacks: dispatchFailedRunCallbacks,
          },
          signal,
        ),
        (error) => {
          log.warn("Failed to bootstrap goal run for provisioned thread", {
            goalId: bootstrapGoal.goalId,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      );
      signal.throwIfAborted();
      if (bootstrap?.kind === "failed-to-enqueue") {
        log.warn("Goal bootstrap run was not enqueued", {
          goalId: bootstrapGoal.goalId,
          reason: bootstrap.kind,
        });
      }
    }
    return { status: 201 as const, body: result.goal };
  }
  return goalErrorResponse(result);
});

const editGoalBody$ = bodyResultOf(goalsContract.edit);

const editGoalInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = goalAuth(get(organizationAuthContext$));
  const bodyResult = await get(editGoalBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const db = set(writeDb$);
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
    const params = get(pathParamsOf(goalsContract.getForChatThread));
    const db = set(writeDb$);
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
    const params = get(pathParamsOf(goalsContract.pauseForChatThread));
    const db = set(writeDb$);
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
  const result = await clearCurrentGoal(db, auth);
  signal.throwIfAborted();
  if (result.kind === "ok") {
    return { status: 200 as const, body: { cleared: true as const } };
  }
  return goalErrorResponse(result);
});

export const goalsRoutes: readonly RouteEntry[] = [
  {
    route: goalsContract.create,
    handler: authRoute(goalUserControlWriteAuth, createGoalInner$),
  },
  {
    route: goalsContract.edit,
    handler: authRoute(goalUserControlWriteAuth, editGoalInner$),
  },
  {
    route: goalsContract.get,
    handler: authRoute(goalReadAuth, getGoalInner$),
  },
  {
    route: goalsContract.getForChatThread,
    handler: authRoute(sessionGoalReadAuth, getChatThreadGoalInner$),
  },
  {
    route: goalsContract.complete,
    handler: authRoute(goalAgentResultWriteAuth, completeGoalInner$),
  },
  {
    route: goalsContract.block,
    handler: authRoute(goalAgentResultWriteAuth, blockGoalInner$),
  },
  {
    route: goalsContract.pause,
    handler: authRoute(goalUserControlWriteAuth, pauseGoalInner$),
  },
  {
    route: goalsContract.pauseForChatThread,
    handler: authRoute(
      sessionGoalUserControlWriteAuth,
      pauseChatThreadGoalInner$,
    ),
  },
  {
    route: goalsContract.resume,
    handler: authRoute(goalUserControlWriteAuth, resumeGoalInner$),
  },
  {
    route: goalsContract.clear,
    handler: authRoute(goalUserControlWriteAuth, clearGoalInner$),
  },
];
