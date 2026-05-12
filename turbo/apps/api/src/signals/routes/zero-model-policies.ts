import { command } from "ccstate";
import { zeroModelPoliciesMainContract } from "@vm0/api-contracts/contracts/zero-model-policies";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { badRequestMessage } from "../../lib/error";
import type { RouteEntry } from "../route";
import {
  listOrgModelPolicies$,
  updateOrgModelPolicies$,
} from "../services/zero-model-policy.service";

const adminRequired = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Only admins can manage model policies",
      code: "FORBIDDEN",
    }),
  }),
});

const updateBody$ = bodyResultOf(zeroModelPoliciesMainContract.update);

const listModelPoliciesInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const body = await set(
      listOrgModelPolicies$,
      { orgId: auth.orgId, userId: auth.userId },
      signal,
    );
    return { status: 200 as const, body };
  },
);

const updateModelPoliciesInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.orgRole !== "admin") {
      return adminRequired;
    }

    const body = await get(updateBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const result = await set(
      updateOrgModelPolicies$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        policies: body.data.policies,
      },
      signal,
    );
    if (!result.ok) {
      return badRequestMessage(result.message);
    }

    return { status: 200 as const, body: result.data };
  },
);

export const zeroModelPoliciesRoutes: readonly RouteEntry[] = [
  {
    route: zeroModelPoliciesMainContract.list,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      listModelPoliciesInner$,
    ),
  },
  {
    route: zeroModelPoliciesMainContract.update,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      updateModelPoliciesInner$,
    ),
  },
];
