import { command } from "ccstate";
import {
  zeroBillingCheckoutContract,
  zeroBillingUsagePackCheckoutContract,
  USAGE_PACKS_USD,
  type MemberUsagePack,
  type UsagePackUsd,
} from "@vm0/api-contracts/contracts/zero-billing";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { isStaffOrg } from "@vm0/core/staff-org";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { eq } from "drizzle-orm";

import { optionalEnv } from "../../lib/env";
import { billingRedirectAllowed } from "../../lib/billing-redirect";
import { badRequestMessage, providerUnavailable } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { clerk$ } from "../external/clerk";
import {
  listAllOrganizationMemberships,
  listAllPendingOrganizationInvitations,
} from "../external/clerk-organization-lists";
import { db$ } from "../external/db";
import {
  activePriceId,
  activeUsagePackPlanPriceId,
  activeUsagePackPriceId,
  completeCheckoutSession$,
  checkoutTierConflictMessage,
  checkoutWouldReplaceWithSameOrLowerTier,
  createCheckoutSession$,
  createUsagePackCheckoutSession$,
} from "../services/zero-billing-checkout.service";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import type { RouteEntry } from "../route-entry";

const adminRequired = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Only org admins can manage billing",
      code: "FORBIDDEN",
    }),
  }),
});

const usagePackCheckoutDisabled = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Usage pack checkout is not enabled",
      code: "FORBIDDEN",
    }),
  }),
});

function memberUsagePackIdsMatch(
  selections: readonly MemberUsagePack[],
  expectedMemberIds: readonly string[],
): boolean {
  const selectedMemberIds = new Set(
    selections.map((selection) => {
      return selection.memberId;
    }),
  );
  return (
    selectedMemberIds.size === selections.length &&
    selectedMemberIds.size === expectedMemberIds.length &&
    expectedMemberIds.every((memberId) => {
      return selectedMemberIds.has(memberId);
    })
  );
}

function usagePackQuantity(
  selections: readonly MemberUsagePack[],
  usagePackUsd: UsagePackUsd,
): number {
  return selections.filter((selection) => {
    return selection.usagePackUsd === usagePackUsd;
  }).length;
}

const checkoutAuthed$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (auth.orgRole !== "admin") {
    return adminRequired;
  }
  signal.throwIfAborted();

  const bodyResult = await get(
    bodyResultOf(zeroBillingCheckoutContract.create),
  );
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const { tier, successUrl, cancelUrl, trialDays, adAttribution } =
    bodyResult.data;

  if (
    !billingRedirectAllowed(successUrl) ||
    !billingRedirectAllowed(cancelUrl)
  ) {
    return badRequestMessage(
      "successUrl and cancelUrl must match the platform origin",
    );
  }

  const priceId = activePriceId(tier);
  if (!priceId) {
    return badRequestMessage(`Price not configured for ${tier} tier`);
  }

  const db = get(db$);
  const [metadata] = await db
    .select({
      onboardingPaymentPending: orgMetadata.onboardingPaymentPending,
      tier: orgMetadata.tier,
    })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, auth.orgId))
    .limit(1);
  signal.throwIfAborted();

  if (
    checkoutWouldReplaceWithSameOrLowerTier({
      currentTier: metadata?.tier,
      targetTier: tier,
    })
  ) {
    return badRequestMessage(
      checkoutTierConflictMessage({
        currentTier: metadata?.tier,
        targetTier: tier,
      }),
    );
  }

  if (trialDays !== undefined) {
    if (tier !== "pro") {
      return badRequestMessage("Trial checkout is only available for Pro tier");
    }
    if (metadata?.onboardingPaymentPending !== true) {
      return badRequestMessage(
        "Pro trial checkout is only available during onboarding",
      );
    }
  }

  const url = await set(
    createCheckoutSession$,
    {
      orgId: auth.orgId,
      tier,
      priceId,
      trialDays,
      successUrl,
      cancelUrl,
      adAttribution,
    },
    signal,
  );
  signal.throwIfAborted();
  return { status: 200 as const, body: { url } };
});

const checkout$ = command(async ({ set }, signal: AbortSignal) => {
  if (!optionalEnv("STRIPE_SECRET_KEY")) {
    return providerUnavailable("Billing not configured");
  }

  return await set(
    authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      checkoutAuthed$,
    ),
    signal,
  );
});

const usagePackCheckoutAuthed$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.orgRole !== "admin") {
      return adminRequired;
    }

    if (!isStaffOrg(auth.orgId)) {
      return usagePackCheckoutDisabled;
    }

    const overrides = await get(
      userFeatureSwitchOverrides(auth.orgId, auth.userId),
    );
    signal.throwIfAborted();
    if (
      !isFeatureEnabled(FeatureSwitchKey.UsagePackPlans, {
        orgId: auth.orgId,
        userId: auth.userId,
        overrides,
      })
    ) {
      return usagePackCheckoutDisabled;
    }
    signal.throwIfAborted();

    const bodyResult = await get(
      bodyResultOf(zeroBillingUsagePackCheckoutContract.create),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const { tier, memberUsagePacks, successUrl, cancelUrl, adAttribution } =
      bodyResult.data;

    if (
      !billingRedirectAllowed(successUrl) ||
      !billingRedirectAllowed(cancelUrl)
    ) {
      return badRequestMessage(
        "successUrl and cancelUrl must match the platform origin",
      );
    }

    const planPriceId = activeUsagePackPlanPriceId(tier);
    if (!planPriceId) {
      return badRequestMessage(
        `Usage pack plan price not configured for ${tier} tier`,
      );
    }

    const clerk = get(clerk$);
    const [memberships, invitations] = await Promise.all([
      listAllOrganizationMemberships(clerk.organizations, auth.orgId),
      listAllPendingOrganizationInvitations(clerk.organizations, auth.orgId),
    ]);
    signal.throwIfAborted();
    const memberIds = memberships.map((membership) => {
      const memberId = membership.publicUserData?.userId;
      if (!memberId) {
        throw new Error("Clerk organization membership is missing its user ID");
      }
      return memberId;
    });
    const expectedMemberIds = [
      ...memberIds,
      ...invitations.map((invitation) => {
        return invitation.id;
      }),
    ];
    if (!memberUsagePackIdsMatch(memberUsagePacks, expectedMemberIds)) {
      return badRequestMessage(
        "Organization members changed; refresh billing and try again",
      );
    }

    const usagePackLineItems: {
      priceId: string;
      quantity: number;
    }[] = [];
    for (const usagePackUsd of USAGE_PACKS_USD) {
      const quantity = usagePackQuantity(memberUsagePacks, usagePackUsd);
      if (quantity === 0) {
        continue;
      }
      const priceId = activeUsagePackPriceId(usagePackUsd);
      if (!priceId) {
        return badRequestMessage(
          `Price not configured for $${usagePackUsd} usage pack`,
        );
      }
      usagePackLineItems.push({ priceId, quantity });
    }

    const db = get(db$);
    const [metadata] = await db
      .select({ tier: orgMetadata.tier })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, auth.orgId))
      .limit(1);
    signal.throwIfAborted();
    if (
      checkoutWouldReplaceWithSameOrLowerTier({
        currentTier: metadata?.tier,
        targetTier: tier,
      })
    ) {
      return badRequestMessage(
        checkoutTierConflictMessage({
          currentTier: metadata?.tier,
          targetTier: tier,
        }),
      );
    }

    const url = await set(
      createUsagePackCheckoutSession$,
      {
        orgId: auth.orgId,
        tier,
        planPriceId,
        usagePackLineItems,
        successUrl,
        cancelUrl,
        adAttribution,
      },
      signal,
    );
    signal.throwIfAborted();
    return { status: 200 as const, body: { url } };
  },
);

const usagePackCheckout$ = command(async ({ set }, signal: AbortSignal) => {
  if (!optionalEnv("STRIPE_SECRET_KEY")) {
    return providerUnavailable("Billing not configured");
  }

  return await set(
    authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      usagePackCheckoutAuthed$,
    ),
    signal,
  );
});

const checkoutCompleteAuthed$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.orgRole !== "admin") {
      return adminRequired;
    }
    signal.throwIfAborted();

    const bodyResult = await get(
      bodyResultOf(zeroBillingCheckoutContract.complete),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const result = await set(
      completeCheckoutSession$,
      { orgId: auth.orgId, sessionId: bodyResult.data.sessionId },
      signal,
    );
    signal.throwIfAborted();

    if (result.status === "customer_mismatch") {
      return badRequestMessage(
        "Checkout session does not belong to current organization",
      );
    }
    if (result.status === "tier_conflict") {
      return badRequestMessage(
        checkoutTierConflictMessage({
          currentTier: result.currentTier,
          targetTier: result.targetTier,
        }),
      );
    }

    return {
      status: 200 as const,
      body: { completed: result.status === "completed" },
    };
  },
);

const checkoutComplete$ = command(async ({ set }, signal: AbortSignal) => {
  if (!optionalEnv("STRIPE_SECRET_KEY")) {
    return providerUnavailable("Billing not configured");
  }

  return await set(
    authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      checkoutCompleteAuthed$,
    ),
    signal,
  );
});

export const zeroBillingCheckoutRoutes: readonly RouteEntry[] = [
  {
    route: zeroBillingCheckoutContract.create,
    handler: checkout$,
  },
  {
    route: zeroBillingCheckoutContract.complete,
    handler: checkoutComplete$,
  },
  {
    route: zeroBillingUsagePackCheckoutContract.create,
    handler: usagePackCheckout$,
  },
];
