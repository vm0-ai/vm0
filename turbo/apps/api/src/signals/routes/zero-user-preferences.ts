import { command, computed } from "ccstate";
import { zeroUserPreferencesContract } from "@vm0/api-contracts/contracts/zero-user-preferences";

import { badRequestMessage } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route";
import {
  updateUserPreferences$,
  userPreferences,
} from "../services/zero-user-data.service";

const updateUserPreferencesBody$ = bodyResultOf(
  zeroUserPreferencesContract.update,
);

const getUserPreferencesInner$ = computed(async (get): Promise<unknown> => {
  const auth = get(organizationAuthContext$);
  const body = await get(
    userPreferences({ orgId: auth.orgId, userId: auth.userId }),
  );
  return {
    status: 200 as const,
    body,
  };
});

const updateUserPreferencesInner$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<unknown> => {
    const auth = get(organizationAuthContext$);
    const body = await get(updateUserPreferencesBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const result = await set(
      updateUserPreferences$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        preferences: body.data,
      },
      signal,
    );
    if (!result.ok) {
      return badRequestMessage(result.message);
    }

    return {
      status: 200 as const,
      body: result.data,
    };
  },
);

export const zeroUserPreferencesRoutes: readonly RouteEntry[] = [
  {
    route: zeroUserPreferencesContract.get,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      getUserPreferencesInner$,
    ),
  },
  {
    route: zeroUserPreferencesContract.update,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      updateUserPreferencesInner$,
    ),
  },
];
