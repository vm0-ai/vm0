import { scrapeContract } from "@okouai/api-contracts/contracts/scrape";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { scrape$ } from "../services/scrape.service";

const scrapeBody$ = bodyResultOf(scrapeContract.scrape);

const scrapeInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(scrapeBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  return await set(scrape$, { auth, body: bodyResult.data }, signal);
});

export const scrapeRoutes: readonly RouteEntry[] = [
  {
    route: scrapeContract.scrape,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "scrape:read",
      },
      scrapeInner$,
    ),
  },
];
