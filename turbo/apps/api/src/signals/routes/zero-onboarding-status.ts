import { computed } from "ccstate";
import { onboardingStatusContract } from "@vm0/api-contracts/contracts/onboarding";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { shadowCompareRoute } from "../context/shadow-compare";
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

export const zeroOnboardingStatusRoutes: readonly RouteEntry[] = [
  {
    route: onboardingStatusContract.getStatus,
    handler: shadowCompareRoute({
      route: onboardingStatusContract.getStatus,
      handler: authRoute({}, getOnboardingStatusInner$),
    }),
  },
];
