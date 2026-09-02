import { command } from "ccstate";
import { onboardingCompleteContract } from "@okouai/api-contracts/contracts/onboarding";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { completeOnboarding$ } from "../services/onboarding.service";
import { bodyResultOf } from "../context/request";
import { publicBrand$ } from "../context/hono";
import type { RouteEntry } from "../route-entry";

const completeBody$ = bodyResultOf(onboardingCompleteContract.complete);

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
    completeOnboarding$,
    {
      orgId: auth.orgId,
      member: { userId: auth.userId, role: auth.orgRole },
      publicBrand: get(publicBrand$),
      timezone: body.data.timezone,
    },
    signal,
  );
});

export const onboardingCompleteRoutes: readonly RouteEntry[] = [
  {
    route: onboardingCompleteContract.complete,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      completeInner$,
    ),
  },
];
