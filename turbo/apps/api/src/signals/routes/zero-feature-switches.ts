import { command, computed } from "ccstate";
import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route";
import {
  deleteUserFeatureSwitches$,
  updateUserFeatureSwitches$,
  userFeatureSwitchOverrides,
} from "../services/feature-switches.service";

const featureSwitchesAuthOptions = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
} as const;

const getFeatureSwitchesInner$ = computed(async (get): Promise<unknown> => {
  const auth = get(organizationAuthContext$);
  const switches = await get(
    userFeatureSwitchOverrides(auth.orgId, auth.userId),
  );
  return {
    status: 200 as const,
    body: { switches },
  };
});

const updateFeatureSwitchesBody$ = bodyResultOf(
  zeroFeatureSwitchesContract.update,
);

const updateFeatureSwitchesInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(updateFeatureSwitchesBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const switches = await set(
      updateUserFeatureSwitches$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        switches: bodyResult.data.switches,
      },
      signal,
    );

    return { status: 200 as const, body: { switches } };
  },
);

const deleteFeatureSwitchesInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    await set(
      deleteUserFeatureSwitches$,
      { orgId: auth.orgId, userId: auth.userId },
      signal,
    );
    return { status: 200 as const, body: { deleted: true as const } };
  },
);

export const zeroFeatureSwitchesRoutes: readonly RouteEntry[] = [
  {
    route: zeroFeatureSwitchesContract.get,
    handler: authRoute(featureSwitchesAuthOptions, getFeatureSwitchesInner$),
  },
  {
    route: zeroFeatureSwitchesContract.update,
    handler: authRoute(featureSwitchesAuthOptions, updateFeatureSwitchesInner$),
  },
  {
    route: zeroFeatureSwitchesContract.delete,
    handler: authRoute(featureSwitchesAuthOptions, deleteFeatureSwitchesInner$),
  },
];
