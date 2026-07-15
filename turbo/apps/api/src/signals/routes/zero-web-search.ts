import { zeroWebSearchContract } from "@vm0/api-contracts/contracts/zero-web-search";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { command } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { db$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { loadUserFeatureSwitchContext } from "../services/feature-switches.service";
import { zeroWebSearch$ } from "../services/zero-web-search.service";

const webSearchBody$ = bodyResultOf(zeroWebSearchContract.search);

const zeroWebSearchDisabled = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Zero Web Search is not enabled",
      code: "FORBIDDEN",
    }),
  }),
});

const zeroWebSearchEnabled$ = command(async ({ get }) => {
  const auth = get(organizationAuthContext$);
  const context = await loadUserFeatureSwitchContext(
    get(db$),
    auth.orgId,
    auth.userId,
  );
  return isFeatureEnabled(FeatureSwitchKey.ZeroWebSearch, context);
});

const webSearchInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (!(await set(zeroWebSearchEnabled$))) {
    return zeroWebSearchDisabled;
  }
  signal.throwIfAborted();

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
