import { command } from "ccstate";
import { orgDefaultAgentContract } from "@vm0/api-contracts/contracts/orgs";

import { isConflictResponse, isNotFoundResponse } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route";
import { setOrgDefaultAgent$ } from "../services/zero-org-default-agent.service";

const adminRequired = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Only org admins can set the default agent",
      code: "FORBIDDEN",
    }),
  }),
});

const setDefaultAgentInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.orgRole !== "admin") {
      return adminRequired;
    }

    const bodyResult = await get(
      bodyResultOf(orgDefaultAgentContract.setDefaultAgent),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const result = await set(
      setOrgDefaultAgent$,
      { orgId: auth.orgId, agentId: bodyResult.data.agentId },
      signal,
    );
    signal.throwIfAborted();

    if (isNotFoundResponse(result)) {
      return result;
    }
    if (isConflictResponse(result)) {
      return result;
    }

    return { status: 200 as const, body: { agentId: result.agentId } };
  },
);

export const zeroDefaultAgentRoutes: readonly RouteEntry[] = [
  {
    route: orgDefaultAgentContract.setDefaultAgent,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      setDefaultAgentInner$,
    ),
  },
];
