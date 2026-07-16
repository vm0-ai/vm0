import { zeroScrapeContract } from "@vm0/api-contracts/contracts/zero-scrape";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { db$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { loadUserFeatureSwitchContext } from "../services/feature-switches.service";
import { zeroScrape$ } from "../services/zero-scrape.service";

const scrapeBody$ = bodyResultOf(zeroScrapeContract.scrape);

const zeroScrapeDisabled = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Zero Scrape is not enabled",
      code: "FORBIDDEN",
    }),
  }),
});

const zeroScrapeEnabled$ = command(async ({ get }) => {
  const auth = get(organizationAuthContext$);
  const context = await loadUserFeatureSwitchContext(
    get(db$),
    auth.orgId,
    auth.userId,
  );
  return isFeatureEnabled(FeatureSwitchKey.ZeroScrape, context);
});

const scrapeInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (!(await set(zeroScrapeEnabled$))) {
    return zeroScrapeDisabled;
  }
  signal.throwIfAborted();

  const bodyResult = await get(scrapeBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  return await set(zeroScrape$, { auth, body: bodyResult.data }, signal);
});

export const zeroScrapeRoutes: readonly RouteEntry[] = [
  {
    route: zeroScrapeContract.scrape,
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
