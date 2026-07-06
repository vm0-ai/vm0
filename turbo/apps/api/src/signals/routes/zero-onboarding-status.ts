import { onboardingStatusContract } from "@vm0/api-contracts/contracts/onboarding";
import { command } from "ccstate";

import { logger } from "../../lib/log";
import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import type { RouteEntry } from "../route-entry";
import { ensureOrgLimitedFreeBootstrap$ } from "../services/org-limited-free-bootstrap.service";
import { onboardingStatus } from "../services/onboarding.service";
import { settle } from "../utils";

const L = logger("zero-onboarding-status.route");

const getOnboardingStatusInner$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<unknown> => {
    const auth = get(authContext$);
    const body = await get(onboardingStatus(auth));
    signal.throwIfAborted();

    if (auth.orgId && body.isAdmin && !body.hasDefaultAgent) {
      const bootstrapResult = await settle(
        set(
          ensureOrgLimitedFreeBootstrap$,
          { orgId: auth.orgId, ownerUserId: auth.userId },
          signal,
        ),
      );
      signal.throwIfAborted();

      if (bootstrapResult.ok) {
        const repairedBody = await get(onboardingStatus(auth));
        signal.throwIfAborted();
        return {
          status: 200 as const,
          body: repairedBody,
        };
      }

      L.warn("Lazy onboarding status bootstrap failed", {
        orgId: auth.orgId,
        error: bootstrapResult.error,
      });
    }

    return {
      status: 200 as const,
      body,
    };
  },
);

export const zeroOnboardingStatusRoutes: readonly RouteEntry[] = [
  {
    route: onboardingStatusContract.getStatus,
    handler: authRoute({}, getOnboardingStatusInner$),
  },
];
