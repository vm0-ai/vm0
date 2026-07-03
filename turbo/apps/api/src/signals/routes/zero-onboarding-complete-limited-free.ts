import { command } from "ccstate";
import { onboardingCompleteLimitedFreeContract } from "@vm0/api-contracts/contracts/onboarding";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { completeLimitedFreeOnboarding$ } from "../services/onboarding.service";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";

const completeBody$ = bodyResultOf(
  onboardingCompleteLimitedFreeContract.complete,
);

const forbidden = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Only org admins can complete onboarding",
      code: "FORBIDDEN",
    }),
  }),
});

const completeInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const body = await get(completeBody$);
  signal.throwIfAborted();

  if (auth.orgRole !== "admin") {
    return forbidden;
  }

  if (!body.ok) {
    return body.response;
  }

  return await set(
    completeLimitedFreeOnboarding$,
    {
      orgId: auth.orgId,
      credits: body.data.credits,
      expiresAt: body.data.expiresAt,
    },
    signal,
  );
});

export const zeroOnboardingCompleteLimitedFreeRoutes: readonly RouteEntry[] = [
  {
    route: onboardingCompleteLimitedFreeContract.complete,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      completeInner$,
    ),
  },
];
