import { command } from "ccstate";
import { zeroBillingConcurrencySubscriptionContract } from "@vm0/api-contracts/contracts/zero-billing";

import { optionalEnv } from "../../lib/env";
import { notFound, providerUnavailable } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import {
  cancelConcurrencySubscription$,
  restoreConcurrencySubscription$,
} from "../services/zero-billing-concurrency-subscription.service";
import type { RouteEntry } from "../route";

const adminRequired = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Only org admins can manage concurrency subscriptions",
      code: "FORBIDDEN",
    }),
  }),
});

const cancelConcurrencySubscriptionAuthed$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.orgRole !== "admin") {
      return adminRequired;
    }
    signal.throwIfAborted();

    const { subscriptionId } = get(
      pathParamsOf(zeroBillingConcurrencySubscriptionContract.cancel),
    );
    const result = await set(
      cancelConcurrencySubscription$,
      { orgId: auth.orgId, subscriptionId },
      signal,
    );
    signal.throwIfAborted();

    if (!result.ok) {
      return notFound("Concurrency subscription not found");
    }

    return {
      status: 200 as const,
      body: {
        success: true as const,
        currentPeriodEnd: result.currentPeriodEnd,
      },
    };
  },
);

const cancelConcurrencySubscriptionRoute$ = command(
  async ({ set }, signal: AbortSignal) => {
    if (!optionalEnv("STRIPE_SECRET_KEY")) {
      return providerUnavailable("Billing not configured");
    }

    return await set(
      authRoute(
        {
          requireOrganization: true,
          missingOrganizationStatus: 401,
          requiredCapability: "billing:write",
        },
        cancelConcurrencySubscriptionAuthed$,
      ),
      signal,
    );
  },
);

const restoreConcurrencySubscriptionAuthed$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.orgRole !== "admin") {
      return adminRequired;
    }
    signal.throwIfAborted();

    const { subscriptionId } = get(
      pathParamsOf(zeroBillingConcurrencySubscriptionContract.restore),
    );
    const result = await set(
      restoreConcurrencySubscription$,
      { orgId: auth.orgId, subscriptionId },
      signal,
    );
    signal.throwIfAborted();

    if (!result.ok) {
      return notFound("Concurrency subscription not found");
    }

    return {
      status: 200 as const,
      body: {
        success: true as const,
      },
    };
  },
);

const restoreConcurrencySubscriptionRoute$ = command(
  async ({ set }, signal: AbortSignal) => {
    if (!optionalEnv("STRIPE_SECRET_KEY")) {
      return providerUnavailable("Billing not configured");
    }

    return await set(
      authRoute(
        {
          requireOrganization: true,
          missingOrganizationStatus: 401,
          requiredCapability: "billing:write",
        },
        restoreConcurrencySubscriptionAuthed$,
      ),
      signal,
    );
  },
);

export const zeroBillingConcurrencySubscriptionRoutes: readonly RouteEntry[] = [
  {
    route: zeroBillingConcurrencySubscriptionContract.cancel,
    handler: cancelConcurrencySubscriptionRoute$,
  },
  {
    route: zeroBillingConcurrencySubscriptionContract.restore,
    handler: restoreConcurrencySubscriptionRoute$,
  },
];
