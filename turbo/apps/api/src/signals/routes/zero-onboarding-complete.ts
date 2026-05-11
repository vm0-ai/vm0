import { command } from "ccstate";
import { onboardingCompleteContract } from "@vm0/api-contracts/contracts/onboarding";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { completeOnboarding$ } from "../services/onboarding.service";
import type { RouteEntry } from "../route";

const completeBody$ = bodyResultOf(onboardingCompleteContract.complete);

const completeInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const body = await get(completeBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }

  await set(
    completeOnboarding$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      selectedConnectors: body.data.selectedConnectors ?? [],
    },
    signal,
  );

  return { status: 200 as const, body: { ok: true } };
});

export const zeroOnboardingCompleteRoutes: readonly RouteEntry[] = [
  {
    route: onboardingCompleteContract.complete,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      completeInner$,
    ),
  },
];
