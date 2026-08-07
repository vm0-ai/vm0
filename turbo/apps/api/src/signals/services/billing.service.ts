import type StripeSDK from "stripe";
import { command, computed, type Computed } from "ccstate";
import type { AutoRechargeConfig } from "@vm0/api-contracts/contracts/zero-billing";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { orgUsageAllowanceEntitlements } from "@vm0/db/schema/org-usage-allowance";
import { eq } from "drizzle-orm";

import { db$, writeDb$, type ReadonlyDb } from "../external/db";
import { nowDate } from "../../lib/time";
import { getStripeClient } from "../external/stripe-client";
import { getOrCreateStripeCustomer$ } from "./billing-customer.service";
import { loadOrgPlanCapabilities } from "./org-plan-entitlement-read.service";

const PAYMENT_METHOD_PORTAL_CONFIGURATION_NAME = "VM0 payment methods";
const PAYMENT_METHOD_PORTAL_CONFIGURATION_IDEMPOTENCY_KEY =
  "vm0-payment-method-portal-v1";
const PAYMENT_METHOD_PORTAL_METADATA = {
  managed_by: "vm0",
  purpose: "payment_method_management",
} as const;

function paymentMethodPortalFeatures(): StripeSDK.BillingPortal.ConfigurationCreateParams.Features {
  return {
    customer_update: { enabled: false },
    invoice_history: { enabled: false },
    payment_method_update: { enabled: true },
    subscription_cancel: { enabled: false },
    subscription_update: { enabled: false },
  };
}

function isManagedPaymentMethodPortalConfiguration(
  configuration: StripeSDK.BillingPortal.Configuration,
): boolean {
  return (
    configuration.metadata?.managed_by ===
      PAYMENT_METHOD_PORTAL_METADATA.managed_by &&
    configuration.metadata.purpose === PAYMENT_METHOD_PORTAL_METADATA.purpose
  );
}

function isRestrictedPaymentMethodPortalConfiguration(
  configuration: StripeSDK.BillingPortal.Configuration,
): boolean {
  return (
    configuration.active &&
    !configuration.features.customer_update.enabled &&
    !configuration.features.invoice_history.enabled &&
    configuration.features.payment_method_update.enabled &&
    !configuration.features.subscription_cancel.enabled &&
    !configuration.features.subscription_update.enabled &&
    !configuration.login_page.enabled
  );
}

async function ensurePaymentMethodPortalConfiguration(
  stripe: StripeSDK,
  signal: AbortSignal,
): Promise<string> {
  const configurations = await stripe.billingPortal.configurations.list({
    limit: 100,
  });
  signal.throwIfAborted();

  const existing = configurations.data.find(
    isManagedPaymentMethodPortalConfiguration,
  );
  if (!existing) {
    const created = await stripe.billingPortal.configurations.create(
      {
        name: PAYMENT_METHOD_PORTAL_CONFIGURATION_NAME,
        features: paymentMethodPortalFeatures(),
        login_page: { enabled: false },
        metadata: PAYMENT_METHOD_PORTAL_METADATA,
      },
      { idempotencyKey: PAYMENT_METHOD_PORTAL_CONFIGURATION_IDEMPOTENCY_KEY },
    );
    signal.throwIfAborted();
    return created.id;
  }

  if (isRestrictedPaymentMethodPortalConfiguration(existing)) {
    return existing.id;
  }

  const updated = await stripe.billingPortal.configurations.update(
    existing.id,
    {
      active: true,
      name: PAYMENT_METHOD_PORTAL_CONFIGURATION_NAME,
      features: paymentMethodPortalFeatures(),
      login_page: { enabled: false },
      metadata: PAYMENT_METHOD_PORTAL_METADATA,
    },
  );
  signal.throwIfAborted();
  return updated.id;
}

export function autoRechargeConfig(
  orgId: string,
): Computed<Promise<AutoRechargeConfig>> {
  return computed(async (get): Promise<AutoRechargeConfig> => {
    const db = get(db$);
    const [row] = await db
      .select({
        autoRechargeEnabled: orgMetadata.autoRechargeEnabled,
        autoRechargeThreshold: orgMetadata.autoRechargeThreshold,
        autoRechargeAmount: orgMetadata.autoRechargeAmount,
      })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, orgId))
      .limit(1);

    return {
      enabled: row?.autoRechargeEnabled ?? false,
      threshold: row?.autoRechargeThreshold ?? null,
      amount: row?.autoRechargeAmount ?? null,
    };
  });
}

async function stripeCustomerIdForOrg(
  db: ReadonlyDb,
  orgId: string,
): Promise<string | null> {
  const [org] = await db
    .select({ stripeCustomerId: orgMetadata.stripeCustomerId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  if (org?.stripeCustomerId) {
    return org.stripeCustomerId;
  }

  const [allowance] = await db
    .select({
      stripeCustomerId: orgUsageAllowanceEntitlements.stripeCustomerId,
    })
    .from(orgUsageAllowanceEntitlements)
    .where(eq(orgUsageAllowanceEntitlements.orgId, orgId))
    .limit(1);
  return allowance?.stripeCustomerId ?? null;
}

/**
 * Create a Stripe Billing Portal session for managing the org's saved payment
 * methods.
 */
export const createBillingPortalSession$ = command(
  async (
    { get, set },
    args: {
      readonly orgId: string;
      readonly returnUrl: string;
      readonly paymentMethodManagementEnabled: boolean;
    },
    signal: AbortSignal,
  ): Promise<string> => {
    const db = get(db$);
    let stripeCustomerId = await stripeCustomerIdForOrg(db, args.orgId);
    signal.throwIfAborted();

    if (!stripeCustomerId && !args.paymentMethodManagementEnabled) {
      throw new Error("Org has no Stripe customer — subscribe first");
    }

    if (!stripeCustomerId) {
      stripeCustomerId = await set(
        getOrCreateStripeCustomer$,
        { orgId: args.orgId },
        signal,
      );
      signal.throwIfAborted();
    }

    const stripe = getStripeClient();
    if (!args.paymentMethodManagementEnabled) {
      const session = await stripe.billingPortal.sessions.create({
        customer: stripeCustomerId,
        return_url: args.returnUrl,
      });
      signal.throwIfAborted();
      return session.url;
    }

    const portalConfigurationId = await ensurePaymentMethodPortalConfiguration(
      stripe,
      signal,
    );
    signal.throwIfAborted();

    const session = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      configuration: portalConfigurationId,
      return_url: args.returnUrl,
    });
    signal.throwIfAborted();

    return session.url;
  },
);

type UpdateAutoRechargeResult =
  | { readonly ok: true; readonly data: AutoRechargeConfig }
  | { readonly ok: false; readonly error: string };

interface UpdateAutoRechargeArgs {
  readonly orgId: string;
  readonly enabled: boolean;
  readonly threshold?: number;
  readonly amount?: number;
}

export const updateAutoRechargeConfig$ = command(
  async (
    { set },
    args: UpdateAutoRechargeArgs,
    signal: AbortSignal,
  ): Promise<UpdateAutoRechargeResult> => {
    const { orgId, enabled, threshold, amount } = args;
    const writeDb = set(writeDb$);

    if (enabled) {
      const capabilities = await loadOrgPlanCapabilities(writeDb, orgId);
      signal.throwIfAborted();

      if (capabilities?.autoRechargeAllowed !== true) {
        return {
          ok: false,
          error:
            "Auto-recharge is only available for Pro, Team, or Custom workspaces",
        };
      }
      if (threshold === undefined || amount === undefined) {
        return {
          ok: false,
          error:
            "threshold and amount are required when enabling auto-recharge",
        };
      }
      if (threshold >= amount) {
        return {
          ok: false,
          error: "threshold must be less than amount to avoid recharge loops",
        };
      }
    }

    await writeDb
      .update(orgMetadata)
      .set({
        autoRechargeEnabled: enabled,
        autoRechargeThreshold: enabled ? threshold : null,
        autoRechargeAmount: enabled ? amount : null,
        ...(!enabled ? { autoRechargePendingAt: null } : {}),
        updatedAt: nowDate(),
      })
      .where(eq(orgMetadata.orgId, orgId));
    signal.throwIfAborted();

    return {
      ok: true,
      data: {
        enabled,
        threshold: enabled ? (threshold ?? null) : null,
        amount: enabled ? (amount ?? null) : null,
      },
    };
  },
);
