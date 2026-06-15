import { computed } from "ccstate";
import { sessionsByIdContract } from "@vm0/api-contracts/contracts/sessions";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { notFound } from "../../lib/error";
import { agentSessionById } from "../services/agent-sessions.service";
import type { RouteEntry } from "../route";

const sessionNotFound = notFound("Session not found");

function sessionForbidden() {
  return {
    status: 403 as const,
    body: {
      error: {
        message: "You do not have permission to access this session",
        code: "FORBIDDEN",
      },
    },
  };
}

const getSessionByIdInner$ = computed(async (get) => {
  const auth = get(authContext$);
  const params = get(pathParamsOf(sessionsByIdContract.getById));

  if (!auth.orgId) {
    return sessionNotFound;
  }

  const result = await get(
    agentSessionById({
      sessionId: params.id,
      userId: auth.userId,
      orgId: auth.orgId,
    }),
  );

  switch (result.kind) {
    case "ok": {
      return { status: 200 as const, body: result.session };
    }
    case "forbidden": {
      return sessionForbidden();
    }
    case "not-found": {
      return sessionNotFound;
    }
  }
});

export const agentSessionsRoutes: readonly RouteEntry[] = [
  {
    route: sessionsByIdContract.getById,
    handler: authRoute({}, getSessionByIdInner$),
  },
];
