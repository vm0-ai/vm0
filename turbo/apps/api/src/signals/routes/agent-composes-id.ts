import { command, computed } from "ccstate";
import { composesByIdContract } from "@vm0/api-contracts/contracts/composes";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { isConflictResponse, isNotFoundResponse } from "../../lib/error";
import { deleteCompose$ } from "../services/zero-compose-data.service";
import {
  agentComposeById,
  agentComposeOrgId,
} from "../services/agent-composes-read.service";
import type { RouteEntry } from "../route";

const sandboxDeleteForbidden = {
  status: 403 as const,
  body: {
    error: {
      message: "Agent deletion is not available from sandbox",
      code: "FORBIDDEN",
    },
  },
} as const;

const deleteAgentComposeInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(authContext$);
    if (auth.tokenType === "sandbox" || auth.tokenType === "zero") {
      return sandboxDeleteForbidden;
    }

    const params = get(pathParamsOf(composesByIdContract.delete));
    const result = await set(
      deleteCompose$,
      { composeId: params.id, userId: auth.userId },
      signal,
    );
    signal.throwIfAborted();

    if (isNotFoundResponse(result)) {
      return result;
    }
    if (isConflictResponse(result)) {
      return result;
    }
    return { status: 204 as const, body: undefined };
  },
);

const getAgentComposeInner$ = computed(async (get) => {
  const auth = get(authContext$);
  const params = get(pathParamsOf(composesByIdContract.getById));
  const orgId =
    auth.tokenType === "sandbox" || auth.tokenType === "zero"
      ? await get(agentComposeOrgId(params.id))
      : (auth.orgId ?? null);

  if (!orgId) {
    return {
      status: 404 as const,
      body: {
        error: { message: "Agent compose not found", code: "NOT_FOUND" },
      },
    };
  }

  const compose = await get(
    agentComposeById({
      composeId: params.id,
      userId: auth.userId,
      orgId,
    }),
  );
  if (!compose) {
    return {
      status: 404 as const,
      body: {
        error: { message: "Agent compose not found", code: "NOT_FOUND" },
      },
    };
  }

  return { status: 200 as const, body: compose };
});

const anySandboxAuth = {
  acceptAnySandboxCapability: true,
} as const;

export const agentComposesByIdRoutes: readonly RouteEntry[] = [
  {
    route: composesByIdContract.getById,
    handler: authRoute(anySandboxAuth, getAgentComposeInner$),
  },
  {
    route: composesByIdContract.delete,
    handler: authRoute(anySandboxAuth, deleteAgentComposeInner$),
  },
];
