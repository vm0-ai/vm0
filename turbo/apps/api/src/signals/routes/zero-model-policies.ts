import { command } from "ccstate";
import { zeroModelPoliciesMainContract } from "@vm0/api-contracts/contracts/zero-model-policies";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { badRequestMessage } from "../../lib/error";
import type { RouteEntry } from "../route";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import {
  listOrgModelPolicies$,
  updateOrgModelPolicies$,
} from "../services/zero-model-policy.service";

const modelPoliciesDisabled = Object.freeze({
  status: 404 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Model-first model provider controls are not available",
      code: "NOT_FOUND",
    }),
  }),
});

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

async function isModelPolicyEnabled(
  get: {
    <T>(signal: import("ccstate").Computed<T>): T;
    <T>(signal: import("ccstate").Computed<Promise<T>>): Promise<T>;
  },
  orgId: string,
  userId: string,
): Promise<boolean> {
  const overrides = await get(userFeatureSwitchOverrides(orgId, userId));
  return isFeatureEnabled(FeatureSwitchKey.ModelFirstModelProvider, {
    orgId,
    userId,
    overrides,
  });
}

const listModelPoliciesInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (!(await isModelPolicyEnabled(get, auth.orgId, auth.userId))) {
      return modelPoliciesDisabled;
    }

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
    if (!(await isModelPolicyEnabled(get, auth.orgId, auth.userId))) {
      return modelPoliciesDisabled;
    }
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
