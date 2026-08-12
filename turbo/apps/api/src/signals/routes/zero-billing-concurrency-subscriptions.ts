import { command } from "ccstate";
import { zeroBillingConcurrencySubscriptionContract } from "@vm0/api-contracts/contracts/zero-billing";

import { billingRedirectAllowed } from "../../lib/billing-redirect";
import { optionalEnv } from "../../lib/env";
import {
  badRequestMessage,
  conflict,
  notFound,
  providerUnavailable,
} from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import {
  cancelConcurrencySubscription$,
  changeConcurrencySubscription$,
  previewConcurrencySubscriptionChange$,
  reduceConcurrencySubscription$,
  restoreConcurrencySubscription$,
} from "../services/zero-billing-concurrency-subscription.service";
import type { RouteEntry } from "../route-entry";

const adminRequired = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Only org admins can manage concurrency subscriptions",
      code: "FORBIDDEN",
    }),
  }),
});

const previewConcurrencySubscriptionChangeAuthed$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.orgRole !== "admin") {
      return adminRequired;
    }
    signal.throwIfAborted();

    const bodyResult = await get(
      bodyResultOf(zeroBillingConcurrencySubscriptionContract.previewChange),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const { subscriptionId } = get(
      pathParamsOf(zeroBillingConcurrencySubscriptionContract.previewChange),
    );
    const result = await set(
      previewConcurrencySubscriptionChange$,
      {
        orgId: auth.orgId,
        subscriptionId,
        quantity: bodyResult.data.quantity,
      },
      signal,
    );
    signal.throwIfAborted();

    if (!result.ok) {
      switch (result.reason) {
        case "not_found": {
          return notFound("Concurrency subscription not found");
        }
        case "canceling": {
          return badRequestMessage(
            "Restore the concurrency subscription before changing slots",
          );
        }
        case "invalid_quantity": {
          return badRequestMessage(
            "Concurrency quantity cannot exceed 1000 slots",
          );
        }
        case "no_change": {
          return badRequestMessage(
            "New concurrency quantity must differ from the current quantity",
          );
        }
        case "pending_update": {
          return conflict(
            "Complete the pending concurrency update before changing slots",
          );
        }
      }
    }

    return { status: 200 as const, body: result.preview };
  },
);

const previewConcurrencySubscriptionChangeRoute$ = command(
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
        previewConcurrencySubscriptionChangeAuthed$,
      ),
      signal,
    );
  },
);

const confirmConcurrencySubscriptionChangeAuthed$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.orgRole !== "admin") {
      return adminRequired;
    }
    signal.throwIfAborted();

    const bodyResult = await get(
      bodyResultOf(zeroBillingConcurrencySubscriptionContract.confirmChange),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const { subscriptionId } = get(
      pathParamsOf(zeroBillingConcurrencySubscriptionContract.confirmChange),
    );
    const result = await set(
      changeConcurrencySubscription$,
      {
        orgId: auth.orgId,
        subscriptionId,
        quantity: bodyResult.data.quantity,
      },
      signal,
    );
    signal.throwIfAborted();

    if (!result.ok) {
      switch (result.reason) {
        case "not_found": {
          return notFound("Concurrency subscription not found");
        }
        case "canceling": {
          return badRequestMessage(
            "Restore the concurrency subscription before changing slots",
          );
        }
        case "invalid_quantity": {
          return badRequestMessage(
            "Concurrency quantity must be between 1 and 1000 slots",
          );
        }
        case "pending_update": {
          return conflict(
            "Complete the pending concurrency update before changing slots",
          );
        }
      }
    }

    return { status: 200 as const, body: result.response };
  },
);

const confirmConcurrencySubscriptionChangeRoute$ = command(
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
        confirmConcurrencySubscriptionChangeAuthed$,
      ),
      signal,
    );
  },
);

const reduceConcurrencySubscriptionAuthed$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.orgRole !== "admin") {
      return adminRequired;
    }
    signal.throwIfAborted();

    const bodyResult = await get(
      bodyResultOf(zeroBillingConcurrencySubscriptionContract.reduce),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const { quantity, successUrl, cancelUrl } = bodyResult.data;
    if (
      !billingRedirectAllowed(successUrl) ||
      !billingRedirectAllowed(cancelUrl)
    ) {
      return badRequestMessage(
        "Billing redirects must use the configured app origin",
      );
    }
    const { subscriptionId } = get(
      pathParamsOf(zeroBillingConcurrencySubscriptionContract.reduce),
    );
    const result = await set(
      reduceConcurrencySubscription$,
      {
        orgId: auth.orgId,
        subscriptionId,
        quantity,
        successUrl,
      },
      signal,
    );
    signal.throwIfAborted();

    if (!result.ok) {
      switch (result.reason) {
        case "not_found": {
          return notFound("Concurrency subscription not found");
        }
        case "canceling": {
          return badRequestMessage(
            "Restore the concurrency subscription before reducing slots",
          );
        }
        case "not_reduction": {
          return badRequestMessage(
            "New concurrency quantity must be lower than the current quantity",
          );
        }
        case "pending_update": {
          return badRequestMessage(
            "Complete the pending concurrency update before reducing slots",
          );
        }
      }
    }

    return {
      status: 200 as const,
      body: { url: result.url },
    };
  },
);

const reduceConcurrencySubscriptionRoute$ = command(
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
        reduceConcurrencySubscriptionAuthed$,
      ),
      signal,
    );
  },
);

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
    route: zeroBillingConcurrencySubscriptionContract.previewChange,
    handler: previewConcurrencySubscriptionChangeRoute$,
  },
  {
    route: zeroBillingConcurrencySubscriptionContract.confirmChange,
    handler: confirmConcurrencySubscriptionChangeRoute$,
  },
  {
    route: zeroBillingConcurrencySubscriptionContract.reduce,
    handler: reduceConcurrencySubscriptionRoute$,
  },
  {
    route: zeroBillingConcurrencySubscriptionContract.cancel,
    handler: cancelConcurrencySubscriptionRoute$,
  },
  {
    route: zeroBillingConcurrencySubscriptionContract.restore,
    handler: restoreConcurrencySubscriptionRoute$,
  },
];
