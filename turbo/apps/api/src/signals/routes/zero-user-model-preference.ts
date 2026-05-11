import { command, computed } from "ccstate";
import { zeroUserModelPreferenceContract } from "@vm0/api-contracts/contracts/zero-user-model-preference";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";

import { badRequestMessage } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import { listOrgModelPolicies$ } from "../services/zero-model-policy.service";
import {
  updateUserModelPreference$,
  userModelPreference,
} from "../services/zero-user-data.service";

const modelFirstDisabled = Object.freeze({
  status: 404 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Model-first model provider controls are not available",
      code: "NOT_FOUND",
    }),
  }),
});

const updateBody$ = bodyResultOf(zeroUserModelPreferenceContract.update);

async function isModelFirstEnabled(
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

const getUserModelPreferenceInner$ = computed(async (get): Promise<unknown> => {
  const auth = get(organizationAuthContext$);
  if (!(await isModelFirstEnabled(get, auth.orgId, auth.userId))) {
    return modelFirstDisabled;
  }
  const body = await get(
    userModelPreference({ orgId: auth.orgId, userId: auth.userId }),
  );
  return { status: 200 as const, body };
});

const updateUserModelPreferenceInner$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<unknown> => {
    const auth = get(organizationAuthContext$);
    if (!(await isModelFirstEnabled(get, auth.orgId, auth.userId))) {
      return modelFirstDisabled;
    }

    const body = await get(updateBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    if (body.data.selectedModel !== null) {
      const policies = await set(
        listOrgModelPolicies$,
        { orgId: auth.orgId, userId: auth.userId },
        signal,
      );
      const configured = policies.policies.some((policy) => {
        return policy.model === body.data.selectedModel;
      });
      if (!configured) {
        return badRequestMessage("Invalid request");
      }
    }

    const result = await set(
      updateUserModelPreference$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        preference: body.data,
      },
      signal,
    );
    return { status: 200 as const, body: result };
  },
);

export const zeroUserModelPreferenceRoutes: readonly RouteEntry[] = [
  {
    route: zeroUserModelPreferenceContract.get,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      getUserModelPreferenceInner$,
    ),
  },
  {
    route: zeroUserModelPreferenceContract.update,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      updateUserModelPreferenceInner$,
    ),
  },
];
