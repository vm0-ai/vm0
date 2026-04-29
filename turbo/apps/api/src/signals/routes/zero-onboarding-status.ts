import { computed } from "ccstate";
import { onboardingStatusContract } from "@vm0/api-contracts/contracts/onboarding";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import {
  shadowCompareRoute,
  type ShadowCompareSource,
} from "../context/shadow-compare";
import type { RouteEntry } from "../route";
import { onboardingStatus } from "../services/onboarding.service";

const getOnboardingStatusInner$ = computed(async (get): Promise<unknown> => {
  const auth = get(authContext$);
  const body = await get(onboardingStatus(auth));
  return {
    status: 200 as const,
    body,
  };
});

export function zeroOnboardingStatusRoutes(
  source: ShadowCompareSource = "web",
): readonly RouteEntry[] {
  return [
    {
      route: onboardingStatusContract.getStatus,
      handler: shadowCompareRoute({
        routeName: "zero.onboarding.status.get",
        handler: authRoute({}, getOnboardingStatusInner$),
        source,
      }),
    },
  ];
}
