import { zeroPeopleSearchContract } from "@vm0/api-contracts/contracts/zero-people-search";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { zeroPeopleSearch$ } from "../services/zero-people-search.service";

const peopleSearchBody$ = bodyResultOf(zeroPeopleSearchContract.search);

const peopleSearchDisabled = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Zero People Search is not enabled",
      code: "FORBIDDEN",
    }),
  }),
});

const peopleSearchInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (
      !isFeatureEnabled(FeatureSwitchKey.ZeroPeopleSearch, {
        userId: auth.userId,
        orgId: auth.orgId,
      })
    ) {
      return peopleSearchDisabled;
    }
    signal.throwIfAborted();
    const bodyResult = await get(peopleSearchBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    return await set(
      zeroPeopleSearch$,
      { auth, body: bodyResult.data },
      signal,
    );
  },
);

export const zeroPeopleSearchRoutes: readonly RouteEntry[] = [
  {
    route: zeroPeopleSearchContract.search,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "people-search:read",
      },
      peopleSearchInner$,
    ),
  },
];
