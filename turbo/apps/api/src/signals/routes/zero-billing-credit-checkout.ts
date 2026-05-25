import { command } from "ccstate";
import { zeroBillingCreditCheckoutContract } from "@vm0/api-contracts/contracts/zero-billing";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { eq } from "drizzle-orm";

import { env, optionalEnv } from "../../lib/env";
import { badRequestMessage, providerUnavailable } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { writeDb$ } from "../external/db";
import { createCreditCheckoutSession$ } from "../services/zero-billing-checkout.service";
import { updateAutoRechargeConfig$ } from "../services/billing.service";
import type { RouteEntry } from "../route";

const adminRequired = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Only org admins can buy credits",
      code: "FORBIDDEN",
    }),
  }),
});

const creditCheckoutAuthed$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.orgRole !== "admin") {
      return adminRequired;
    }
    signal.throwIfAborted();

    const bodyResult = await get(
      bodyResultOf(zeroBillingCreditCheckoutContract.create),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const { credits, successUrl, cancelUrl, autoRecharge } = bodyResult.data;

    const appOrigin = new URL(env("APP_URL")).origin;
    if (
      new URL(successUrl).origin !== appOrigin ||
      new URL(cancelUrl).origin !== appOrigin
    ) {
      return badRequestMessage(
        "successUrl and cancelUrl must match the platform origin",
      );
    }

    if (autoRecharge?.enabled === true) {
      const threshold = autoRecharge.threshold;
      const amount = autoRecharge.amount;
      if (threshold === undefined || amount === undefined) {
        return badRequestMessage(
          "auto-recharge requires both threshold and amount",
        );
      }
      const db = set(writeDb$);
      await db
        .insert(orgMetadata)
        .values({ orgId: auth.orgId })
        .onConflictDoNothing({ target: orgMetadata.orgId });
      signal.throwIfAborted();
      const updateResult = await set(
        updateAutoRechargeConfig$,
        {
          orgId: auth.orgId,
          enabled: true,
          threshold,
          amount,
        },
        signal,
      );
      signal.throwIfAborted();
      if (!updateResult.ok) {
        return badRequestMessage(updateResult.error);
      }
    }

    const url = await set(
      createCreditCheckoutSession$,
      { orgId: auth.orgId, credits, successUrl, cancelUrl },
      signal,
    );
    signal.throwIfAborted();

    if (autoRecharge?.enabled === false) {
      const db = set(writeDb$);
      await db
        .update(orgMetadata)
        .set({
          autoRechargeEnabled: false,
          autoRechargeThreshold: null,
          autoRechargeAmount: null,
          autoRechargePendingAt: null,
        })
        .where(eq(orgMetadata.orgId, auth.orgId));
      signal.throwIfAborted();
    }

    return { status: 200 as const, body: { url } };
  },
);

const creditCheckout$ = command(async ({ set }, signal: AbortSignal) => {
  if (!optionalEnv("STRIPE_SECRET_KEY")) {
    return providerUnavailable("Billing not configured");
  }

  return await set(
    authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      creditCheckoutAuthed$,
    ),
    signal,
  );
});

export const zeroBillingCreditCheckoutRoutes: readonly RouteEntry[] = [
  {
    route: zeroBillingCreditCheckoutContract.create,
    handler: creditCheckout$,
  },
];
