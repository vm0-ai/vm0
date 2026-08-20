import { peopleSearchContract } from "@okouai/api-contracts/contracts/people-search";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { peopleSearch$ } from "../services/people-search.service";

const peopleSearchBody$ = bodyResultOf(peopleSearchContract.search);

const peopleSearchInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(peopleSearchBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    return await set(peopleSearch$, { auth, body: bodyResult.data }, signal);
  },
);

export const peopleSearchRoutes: readonly RouteEntry[] = [
  {
    route: peopleSearchContract.search,
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
