import { zeroWebSearchContract } from "@vm0/api-contracts/contracts/zero-web-search";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { zeroWebSearch$ } from "../services/zero-web-search.service";

const webSearchBody$ = bodyResultOf(zeroWebSearchContract.search);

const webSearchInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(webSearchBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  return await set(zeroWebSearch$, { auth, body: bodyResult.data }, signal);
});

export const zeroWebSearchRoutes: readonly RouteEntry[] = [
  {
    route: zeroWebSearchContract.search,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "web-search:read",
      },
      webSearchInner$,
    ),
  },
];
