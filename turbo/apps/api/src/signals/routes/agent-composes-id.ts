import { computed } from "ccstate";
import { composesByIdContract } from "@vm0/api-contracts/contracts/composes";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import {
  agentComposeById,
  agentComposeOrgId,
} from "../services/agent-composes-read.service";
import type { RouteEntry } from "../route-entry";

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
];
