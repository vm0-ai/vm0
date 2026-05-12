import { command } from "ccstate";
import { onboardingSetupContract } from "@vm0/api-contracts/contracts/onboarding";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { setupOnboarding$ } from "../services/onboarding.service";
import type { RouteEntry } from "../route";

const setupBody$ = bodyResultOf(onboardingSetupContract.setup);

const forbidden = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Only org admins can run onboarding setup",
      code: "FORBIDDEN",
    }),
  }),
});

const setupInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const body = await get(setupBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }

  if (auth.orgRole !== "admin") {
    return forbidden;
  }

  return await set(
    setupOnboarding$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      displayName: body.data.displayName,
      workspaceName: body.data.workspaceName,
      sound: body.data.sound,
      avatarUrl: body.data.avatarUrl,
      selectedConnectors: body.data.selectedConnectors ?? [],
      timezone: body.data.timezone,
    },
    signal,
  );
});

export const zeroOnboardingSetupRoutes: readonly RouteEntry[] = [
  {
    route: onboardingSetupContract.setup,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      setupInner$,
    ),
  },
];
