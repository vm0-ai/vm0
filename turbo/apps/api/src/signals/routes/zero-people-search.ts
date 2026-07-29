import { zeroPeopleSearchContract } from "@vm0/api-contracts/contracts/zero-people-search";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { zeroPeopleSearch$ } from "../services/zero-people-search.service";

const peopleSearchBody$ = bodyResultOf(zeroPeopleSearchContract.search);

const peopleSearchInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
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
