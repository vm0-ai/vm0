import { command, computed } from "ccstate";
import { zeroUserModelPreferenceContract } from "@vm0/api-contracts/contracts/zero-user-model-preference";

import { badRequestMessage } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route";
import { listOrgModelPolicies$ } from "../services/zero-model-policy.service";
import {
  updateUserModelPreference$,
  userModelPreference,
} from "../services/zero-user-data.service";

const updateBody$ = bodyResultOf(zeroUserModelPreferenceContract.update);

const getUserModelPreferenceInner$ = computed(async (get): Promise<unknown> => {
  const auth = get(organizationAuthContext$);
  const body = await get(
    userModelPreference({ orgId: auth.orgId, userId: auth.userId }),
  );
  return { status: 200 as const, body };
});

const updateUserModelPreferenceInner$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<unknown> => {
    const auth = get(organizationAuthContext$);
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
