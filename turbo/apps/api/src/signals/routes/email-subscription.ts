import { emailSubscriptionContract } from "@okouai/api-contracts/contracts/email-subscription";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { command, computed } from "ccstate";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import {
  emailSubscription$,
  updateEmailSubscription$,
} from "../services/email-subscription.service";

const emailSubscriptionAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  accept: ["session"],
} as const;

const emailSubscriptionEnabled$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const overrides = await get(
    userFeatureSwitchOverrides(auth.orgId, auth.userId),
  );
  return isFeatureEnabled(FeatureSwitchKey.MorningBrief, {
    userId: auth.userId,
    orgId: auth.orgId,
    overrides,
  });
});

function forbidden() {
  return {
    status: 403 as const,
    body: {
      error: {
        code: "FORBIDDEN",
        message: "Morning Brief is not enabled",
      },
    },
  };
}

const getEmailSubscription$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const enabled = await get(emailSubscriptionEnabled$);
    signal.throwIfAborted();
    if (!enabled) {
      return forbidden();
    }
    const auth = get(organizationAuthContext$);
    const body = await set(emailSubscription$, auth.userId, signal);
    return { status: 200 as const, body };
  },
);

const updateBody$ = bodyResultOf(emailSubscriptionContract.update);
const putEmailSubscription$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const enabled = await get(emailSubscriptionEnabled$);
    signal.throwIfAborted();
    if (!enabled) {
      return forbidden();
    }
    const body = await get(updateBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const auth = get(organizationAuthContext$);
    const result = await set(
      updateEmailSubscription$,
      auth.userId,
      body.data.subscribed,
      signal,
    );
    return { status: 200 as const, body: result };
  },
);

export const emailSubscriptionRoutes: readonly RouteEntry[] = [
  {
    route: emailSubscriptionContract.get,
    handler: authRoute(emailSubscriptionAuth, getEmailSubscription$),
  },
  {
    route: emailSubscriptionContract.update,
    handler: authRoute(emailSubscriptionAuth, putEmailSubscription$),
  },
];
