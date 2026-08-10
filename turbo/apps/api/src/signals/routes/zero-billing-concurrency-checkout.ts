import { command } from "ccstate";
import { zeroBillingConcurrencyCheckoutContract } from "@vm0/api-contracts/contracts/zero-billing";

import { optionalEnv } from "../../lib/env";
import { billingRedirectAllowed } from "../../lib/billing-redirect";
import { badRequestMessage, providerUnavailable } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { db$, type ReadonlyDb } from "../external/db";
import {
  activeConcurrencyPriceId,
  activeConcurrencySubscriptions,
  type ActiveConcurrencySubscription,
} from "../services/org-concurrency-entitlements.service";
import { startConcurrencyPurchase$ } from "../services/zero-billing-checkout.service";
import { loadOrgPlanCapabilities } from "../services/org-plan-entitlement-read.service";
import type { RouteEntry } from "../route-entry";

const adminRequired = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Only org admins can buy concurrency",
      code: "FORBIDDEN",
    }),
  }),
});

type ConcurrencyPurchaseTarget =
  | {
      readonly ok: true;
      readonly priceId: string;
      readonly existingSubscription: ActiveConcurrencySubscription | undefined;
    }
  | { readonly ok: false; readonly message: string };

async function loadConcurrencyPurchaseTarget(
  db: ReadonlyDb,
  orgId: string,
  signal: AbortSignal,
): Promise<ConcurrencyPurchaseTarget> {
  const capabilities = await loadOrgPlanCapabilities(db, orgId);
  signal.throwIfAborted();
  if (capabilities?.canBuyConcurrency !== true) {
    return {
      ok: false,
      message:
        "Additional concurrency is only available for Team or Custom workspaces",
    };
  }

  const priceId = activeConcurrencyPriceId();
  if (!priceId) {
    return { ok: false, message: "Concurrency price not configured" };
  }

  const subscriptions = await activeConcurrencySubscriptions(db, orgId);
  signal.throwIfAborted();
  const existingSubscription = subscriptions.find((subscription) => {
    return !subscription.cancelAtPeriodEnd;
  });
  if (!existingSubscription && subscriptions.length > 0) {
    return {
      ok: false,
      message:
        "Restore the existing concurrency subscription before buying more slots",
    };
  }

  return {
    ok: true,
    priceId,
    existingSubscription,
  };
}

const concurrencyCheckoutAuthed$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.orgRole !== "admin") {
      return adminRequired;
    }
    signal.throwIfAborted();

    const bodyResult = await get(
      bodyResultOf(zeroBillingConcurrencyCheckoutContract.create),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const { quantity, successUrl, cancelUrl } = bodyResult.data;

    const db = get(db$);
    if (
      !billingRedirectAllowed(successUrl) ||
      !billingRedirectAllowed(cancelUrl)
    ) {
      return badRequestMessage(
        "successUrl and cancelUrl must match the platform origin",
      );
    }

    const target = await loadConcurrencyPurchaseTarget(db, auth.orgId, signal);
    if (!target.ok) {
      return badRequestMessage(target.message);
    }

    const purchase = await set(
      startConcurrencyPurchase$,
      {
        orgId: auth.orgId,
        quantity,
        priceId: target.priceId,
        existingSubscriptionId: target.existingSubscription?.id,
        successUrl,
        cancelUrl,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!purchase.ok) {
      return badRequestMessage(
        purchase.reason === "invalid_quantity"
          ? "Concurrency quantity cannot exceed 1000 slots"
          : "Complete the pending concurrency update before adding slots",
      );
    }

    return { status: 200 as const, body: { url: purchase.url } };
  },
);

const concurrencyCheckout$ = command(async ({ set }, signal: AbortSignal) => {
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
      concurrencyCheckoutAuthed$,
    ),
    signal,
  );
});

export const zeroBillingConcurrencyCheckoutRoutes: readonly RouteEntry[] = [
  {
    route: zeroBillingConcurrencyCheckoutContract.create,
    handler: concurrencyCheckout$,
  },
];
