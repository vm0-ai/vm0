import { command } from "ccstate";
import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import {
  shadowCompareRoute,
  type ShadowCompareSource,
} from "../context/shadow-compare";
import type { RouteEntry } from "../route";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";

const MISSING_ORG_RESPONSE = Object.freeze({
  status: 401 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Not authenticated",
      code: "UNAUTHORIZED",
    }),
  }),
});

const getFeatureSwitchesInner$ = command(async ({ get }): Promise<unknown> => {
  const auth = get(authContext$);
  if (!auth.orgId) {
    return MISSING_ORG_RESPONSE;
  }

  const switches = await get(
    userFeatureSwitchOverrides(auth.orgId, auth.userId),
  );
  return {
    status: 200 as const,
    body: { switches },
  };
});

export function zeroFeatureSwitchesRoutes(
  source: ShadowCompareSource = "web",
): readonly RouteEntry[] {
  return [
    {
      route: zeroFeatureSwitchesContract.get,
      handler: shadowCompareRoute({
        routeName: "zero.feature-switches.get",
        handler: authRoute({}, getFeatureSwitchesInner$),
        source,
      }),
    },
  ];
}
