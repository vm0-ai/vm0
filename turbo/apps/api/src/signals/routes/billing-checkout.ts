import { command } from "ccstate";
import {
  zeroBillingCheckoutContract,
  zeroBillingUsagePackCatalogContract,
  zeroBillingUsagePackCheckoutContract,
  zeroBillingUsagePackManagementContract,
  zeroBillingUsagePackMigrationContract,
  type MemberUsagePack,
  type UsagePackCatalogItem,
  type UsagePackSubscriptionChangePreviewResponse,
} from "@okouai/api-contracts/contracts/zero-billing";
import { adAttributionMetadataSchema } from "@okouai/api-contracts/contracts/acquisition-attribution";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { eq } from "drizzle-orm";

import { optionalEnv } from "../../lib/env";
import { billingRedirectAllowed } from "../../lib/billing-redirect";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { settle } from "../utils";
import {
  badRequestMessage,
  conflict,
  notFound,
  providerUnavailable,
} from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { clerk$, type ClerkClient } from "../external/clerk";
import {
  listAllOrganizationMemberships,
  listAllPendingOrganizationInvitations,
} from "../external/clerk-organization-lists";
import { db$, writeDb$, type Db } from "../external/db";
import { getStripeClient } from "../external/stripe-client";
import {
  activePriceId,
  activeUsagePackPlanPriceId,
  activeUsagePackPriceId,
  completeCheckoutSession$,
  confirmPlanPurchase$,
  checkoutTierConflictMessage,
  checkoutWouldReplaceWithSameOrLowerTier,
  startPlanPurchase$,
  type SubscriptionCheckoutTier,
} from "../services/zero-billing-checkout.service";
import {
  confirmUsagePackPurchase$,
  activeUsagePackBillingContext,
  loadUsagePackCatalog,
  startUsagePackPurchase$,
  usagePackSubscriptionSchemaAvailable,
  type UsagePackCheckoutAllocation,
} from "../services/usage-pack-subscription.service";
import { parseBillingPaymentMethodPreviewToken } from "../services/billing-purchase-preview-token.service";
import {
  billingPurchasePreviewEnabled$,
  revalidateBillingPurchase,
  routeBillingPurchasePreview,
  type BillingPurchasePaymentMethod,
} from "../services/billing-payment-method.service";
import {
  confirmUsagePackAllocationChange,
  discardUsagePackAllocationChangePreviewForPaymentSetup,
  getUsagePackManagement,
  previewUsagePackAllocationChange,
  usagePackAllocationChangeSchemaAvailable,
} from "../services/usage-pack-allocation-change.service";
import {
  confirmUsagePackSubscriptionChange,
  discardUsagePackSubscriptionChangePreviewForPaymentSetup,
  previewUsagePackSubscriptionChange,
  usagePackMemberAdditionSchemaAvailable,
  usagePackSubscriptionChangeSchemaAvailable,
} from "../services/usage-pack-plan-change.service";
import {
  confirmUsagePackSubscriptionMigration,
  confirmUsagePackSubscriptionMigrationRevision,
  getUsagePackMigrationState,
  previewUsagePackSubscriptionMigration,
  previewUsagePackSubscriptionMigrationRevision,
  type UsagePackMigrationOwner,
} from "../services/usage-pack-subscription-migration.service";
import { usagePackInvitationPurchaseSchemaAvailable } from "../services/usage-pack-invitation-purchase.service";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import {
  mergeFirstTouchAttribution,
  parseStoredSignupAttribution,
} from "../services/acquisition-attribution.service";
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

const usagePackManagementDisabled = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Usage pack management is not enabled",
      code: "FORBIDDEN",
    }),
  }),
});

const SIGNUP_ATTRIBUTION_KEY = "signup_attribution";
const log = logger("api:zero:billing-checkout");

async function signupAttributionForUser(
  clerk: ClerkClient,
  userId: string,
  signal: AbortSignal,
): Promise<ReturnType<typeof adAttributionMetadataSchema.parse> | undefined> {
  const usersResult = await settle(
    Promise.resolve(
      clerk.users.getUserList({
        userId: [userId],
        limit: 1,
      }),
    ),
    signal,
  );
  if (!usersResult.ok) {
    log.warn("Unable to read Clerk signup attribution for checkout", {
      userId,
      error: usersResult.error,
    });
    return undefined;
  }

  const user = usersResult.value?.data?.find((candidate) => {
    return candidate.id === userId;
  });
  return user
    ? parseStoredSignupAttribution(
        user.privateMetadata?.[SIGNUP_ATTRIBUTION_KEY],
      )
    : undefined;
}

async function checkoutAttribution(
  clerk: ClerkClient,
  userId: string,
  adAttribution: Parameters<typeof mergeFirstTouchAttribution>[0],
  signal: AbortSignal,
): Promise<ReturnType<typeof mergeFirstTouchAttribution>> {
  const storedAttribution = await signupAttributionForUser(
    clerk,
    userId,
    signal,
  );
  return mergeFirstTouchAttribution(adAttribution, storedAttribution);
}

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

function checkoutRedirectsAllowed(
  successUrl: string,
  cancelUrl: string,
): boolean {
  return (
    billingRedirectAllowed(successUrl) && billingRedirectAllowed(cancelUrl)
  );
}

async function validateUsagePackSubscriptionMembers(
  args: {
    readonly clerk: ClerkClient;
    readonly orgId: string;
    readonly memberUsagePacks: readonly MemberUsagePack[];
    readonly allocatedMemberIds: readonly string[];
    readonly memberAdditionSchemaAvailable: boolean;
  },
  signal: AbortSignal,
): Promise<"valid" | "member_additions_unavailable" | "members_changed"> {
  const allocatedMemberIds = new Set(args.allocatedMemberIds);
  const addsMember = args.memberUsagePacks.some((selection) => {
    return !allocatedMemberIds.has(selection.memberId);
  });
  if (!addsMember) {
    return "valid";
  }
  if (!args.memberAdditionSchemaAvailable) {
    return "member_additions_unavailable";
  }
  const memberships = await listAllOrganizationMemberships(
    args.clerk.organizations,
    args.orgId,
  );
  signal.throwIfAborted();
  const activeMemberIds = memberships.map((membership) => {
    const memberId = membership.publicUserData?.userId;
    if (!memberId) {
      throw new Error("Clerk organization membership is missing its user ID");
    }
    return memberId;
  });
  return memberUsagePackIdsMatch(args.memberUsagePacks, activeMemberIds)
    ? "valid"
    : "members_changed";
}

async function routeUsagePackSubscriptionChangePayment(
  args: {
    readonly db: Db;
    readonly orgId: string;
    readonly preview: UsagePackSubscriptionChangePreviewResponse;
    readonly returnUrl: string;
  },
  signal: AbortSignal,
): Promise<
  | { readonly kind: "not_found" }
  | {
      readonly kind: "response";
      readonly body: UsagePackSubscriptionChangePreviewResponse;
    }
> {
  const billing = await activeUsagePackBillingContext(args.db, args.orgId);
  signal.throwIfAborted();
  if (!billing) {
    return { kind: "not_found" };
  }
  const route = await routeBillingPurchasePreview(
    {
      stripe: getStripeClient(),
      orgId: args.orgId,
      customerId: billing.stripeCustomerId,
      subscriptionId: billing.stripeSubscriptionId,
      operation: "usage_pack_subscription",
      operationId: args.preview.changeId,
      returnUrl: args.returnUrl,
    },
    signal,
  );
  if (route.kind === "checkout") {
    await discardUsagePackSubscriptionChangePreviewForPaymentSetup(args.db, {
      orgId: args.orgId,
      changeId: args.preview.changeId,
    });
    signal.throwIfAborted();
    return {
      kind: "response",
      body: { ...args.preview, checkoutUrl: route.url },
    };
  }
  return {
    kind: "response",
    body: {
      ...args.preview,
      paymentMethodPreviewToken: route.paymentMethodPreviewToken,
    },
  };
}

interface UsagePackMembership {
  readonly publicUserData?: { readonly userId?: string | null } | null;
}

interface UsagePackInvitation {
  readonly id: string;
}

interface UsagePackMigrationInvitation extends UsagePackInvitation {
  readonly emailAddress: string;
  readonly role: string;
}

function usagePackMigrationOwners(
  memberships: readonly UsagePackMembership[],
  invitations: readonly UsagePackMigrationInvitation[],
  inviterUserId: string,
): readonly UsagePackMigrationOwner[] {
  return [
    ...memberships.map((membership): UsagePackMigrationOwner => {
      const userId = membership.publicUserData?.userId;
      if (!userId) {
        throw new Error("Clerk organization membership is missing its user ID");
      }
      return { userId };
    }),
    ...invitations.map((invitation): UsagePackMigrationOwner => {
      return {
        invitationId: invitation.id,
        normalizedEmail: invitation.emailAddress.trim().toLowerCase(),
        role:
          invitation.role === "org:admin" || invitation.role === "admin"
            ? "admin"
            : "member",
        inviterUserId,
      };
    }),
  ];
}

function usagePackCheckoutAllocations(
  selections: readonly MemberUsagePack[],
  memberships: readonly UsagePackMembership[],
  invitations: readonly UsagePackInvitation[],
  catalog: readonly UsagePackCatalogItem[],
): readonly UsagePackCheckoutAllocation[] | null {
  const memberIds = memberships.map((membership) => {
    const memberId = membership.publicUserData?.userId;
    if (!memberId) {
      throw new Error("Clerk organization membership is missing its user ID");
    }
    return memberId;
  });
  const invitationIds = invitations.map((invitation) => {
    return invitation.id;
  });
  if (!memberUsagePackIdsMatch(selections, [...memberIds, ...invitationIds])) {
    return null;
  }

  const memberIdSet = new Set(memberIds);
  const invitationIdSet = new Set(invitationIds);
  const catalogSelections = new Set(
    catalog.map((item) => {
      return item.usagePackUsd;
    }),
  );
  return selections.map((selection) => {
    if (!catalogSelections.has(selection.usagePackUsd)) {
      throw new Error(
        `Usage pack $${selection.usagePackUsd} is missing from the catalog`,
      );
    }
    const stripePriceId = activeUsagePackPriceId(selection.usagePackUsd);
    if (!stripePriceId) {
      throw new Error(
        `Usage pack $${selection.usagePackUsd} Price is not configured`,
      );
    }
    if (memberIdSet.has(selection.memberId)) {
      return {
        usagePackUsd: selection.usagePackUsd,
        stripePriceId,
        userId: selection.memberId,
      };
    }
    if (!invitationIdSet.has(selection.memberId)) {
      throw new Error(
        `Usage pack owner ${selection.memberId} is no longer eligible`,
      );
    }
    return {
      usagePackUsd: selection.usagePackUsd,
      stripePriceId,
      invitationId: selection.memberId,
    };
  });
}

async function loadUsagePackCheckoutAllocations(
  args: {
    readonly clerk: ClerkClient;
    readonly orgId: string;
    readonly selections: readonly MemberUsagePack[];
  },
  signal: AbortSignal,
): Promise<readonly UsagePackCheckoutAllocation[] | null> {
  const catalog = await loadUsagePackCatalog();
  signal.throwIfAborted();
  const [memberships, invitations] = await Promise.all([
    listAllOrganizationMemberships(args.clerk.organizations, args.orgId),
    listAllPendingOrganizationInvitations(args.clerk.organizations, args.orgId),
  ]);
  signal.throwIfAborted();
  return usagePackCheckoutAllocations(
    args.selections,
    memberships,
    invitations,
    catalog,
  );
}

function hasActiveLegacyPlanSubscription(
  metadata:
    | {
        readonly tier: string | null;
        readonly stripeSubscriptionId: string | null;
        readonly subscriptionStatus: string | null;
      }
    | undefined,
): boolean {
  return Boolean(
    metadata?.stripeSubscriptionId &&
    metadata.subscriptionStatus === "active" &&
    (metadata.tier === "pro" || metadata.tier === "team"),
  );
}

function usagePackCheckoutTierConflicts(
  metadata:
    | {
        readonly tier: string | null;
        readonly subscriptionStatus: string | null;
      }
    | undefined,
  targetTier: SubscriptionCheckoutTier,
): boolean {
  const configuresGrantedPlan =
    metadata?.subscriptionStatus === "atom_grant" &&
    metadata.tier === targetTier;
  return (
    !configuresGrantedPlan &&
    checkoutWouldReplaceWithSameOrLowerTier({
      currentTier: metadata?.tier,
      targetTier,
    })
  );
}

const confirmPlanPurchaseForOrg$ = command(
  async ({ set }, orgId: string, previewToken: string, signal: AbortSignal) => {
    const result = await set(confirmPlanPurchase$, orgId, previewToken, signal);
    signal.throwIfAborted();
    if (result.status === "invalid_preview") {
      return conflict("Plan purchase preview is no longer valid");
    }
    return { status: 200 as const, body: result.response };
  },
);

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
  if (bodyResult.data.previewToken) {
    const confirmation = await set(
      confirmPlanPurchase$,
      auth.orgId,
      bodyResult.data.previewToken,
      signal,
    );
    signal.throwIfAborted();
    if (confirmation.status !== "invalid_preview") {
      return { status: 200 as const, body: confirmation.response };
    }
  }
  const {
    tier,
    supportsInAppPreview,
    successUrl,
    cancelUrl,
    trialDays,
    adAttribution,
  } = bodyResult.data;
  const previewEnabled = await set(
    billingPurchasePreviewEnabled$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      requested: supportsInAppPreview === true,
    },
    signal,
  );
  const clerk = get(clerk$);
  const resolvedAttribution = await checkoutAttribution(
    clerk,
    auth.userId,
    adAttribution,
    signal,
  );

  if (!checkoutRedirectsAllowed(successUrl, cancelUrl)) {
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
      stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
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

  const result = await set(
    startPlanPurchase$,
    {
      orgId: auth.orgId,
      tier,
      priceId,
      trialDays,
      successUrl,
      cancelUrl,
      adAttribution: resolvedAttribution,
      supportsInAppPreview: previewEnabled,
      subscriptionId: metadata?.stripeSubscriptionId ?? null,
    },
    signal,
  );
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: result.status === "preview" ? result.preview : { url: result.url },
  };
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

const checkoutConfirmAuthed$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.orgRole !== "admin") {
      return adminRequired;
    }
    const bodyResult = await get(
      bodyResultOf(zeroBillingCheckoutContract.confirm),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    return await set(
      confirmPlanPurchaseForOrg$,
      auth.orgId,
      bodyResult.data.previewToken,
      signal,
    );
  },
);

const checkoutConfirm$ = command(async ({ set }, signal: AbortSignal) => {
  if (!optionalEnv("STRIPE_SECRET_KEY")) {
    return providerUnavailable("Billing not configured");
  }
  return await set(
    authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      checkoutConfirmAuthed$,
    ),
    signal,
  );
});

const confirmUsagePackPurchaseForOrg$ = command(
  async ({ set }, orgId: string, previewToken: string, signal: AbortSignal) => {
    const result = await set(
      confirmUsagePackPurchase$,
      orgId,
      previewToken,
      signal,
    );
    signal.throwIfAborted();
    if (result.status === "invalid_preview") {
      return conflict("Usage pack purchase preview is no longer valid");
    }
    return { status: 200 as const, body: result.response };
  },
);

const usagePackCheckoutAuthed$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.orgRole !== "admin") {
      return adminRequired;
    }

    const bodyResult = await get(
      bodyResultOf(zeroBillingUsagePackCheckoutContract.create),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    if (bodyResult.data.previewToken) {
      return await set(
        confirmUsagePackPurchaseForOrg$,
        auth.orgId,
        bodyResult.data.previewToken,
        signal,
      );
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

    const db = get(db$);
    if (!(await usagePackSubscriptionSchemaAvailable(db))) {
      return providerUnavailable("Usage pack billing is not ready");
    }
    signal.throwIfAborted();

    const body = bodyResult.data;
    const previewEnabled = await set(
      billingPurchasePreviewEnabled$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        requested: body.supportsInAppPreview === true,
      },
      signal,
    );
    const clerk = get(clerk$);
    const resolvedAttribution = await checkoutAttribution(
      clerk,
      auth.userId,
      body.adAttribution,
      signal,
    );

    if (!checkoutRedirectsAllowed(body.successUrl, body.cancelUrl)) {
      return badRequestMessage(
        "successUrl and cancelUrl must match the platform origin",
      );
    }

    const planPriceId = activeUsagePackPlanPriceId(body.tier);
    if (!planPriceId) {
      return badRequestMessage(
        `Usage pack plan price not configured for ${body.tier} tier`,
      );
    }

    const [metadata] = await db
      .select({
        tier: orgMetadata.tier,
        stripeSubscriptionId: orgMetadata.stripeSubscriptionId,
        subscriptionStatus: orgMetadata.subscriptionStatus,
      })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, auth.orgId))
      .limit(1);
    signal.throwIfAborted();
    if (hasActiveLegacyPlanSubscription(metadata)) {
      return badRequestMessage(
        "Existing subscriptions must migrate before starting usage pack checkout",
      );
    }

    const allocations = await loadUsagePackCheckoutAllocations(
      {
        clerk,
        orgId: auth.orgId,
        selections: body.memberUsagePacks,
      },
      signal,
    );
    if (!allocations) {
      return badRequestMessage(
        "Organization members changed; refresh billing and try again",
      );
    }

    if (usagePackCheckoutTierConflicts(metadata, body.tier)) {
      return badRequestMessage(
        checkoutTierConflictMessage({
          currentTier: metadata?.tier,
          targetTier: body.tier,
        }),
      );
    }

    const result = await set(
      startUsagePackPurchase$,
      {
        orgId: auth.orgId,
        tier: body.tier,
        planPriceId,
        allocations,
        successUrl: body.successUrl,
        cancelUrl: body.cancelUrl,
        adAttribution: resolvedAttribution,
        supportsInAppPreview: previewEnabled,
        sourceSubscriptionId: metadata?.stripeSubscriptionId ?? null,
      },
      signal,
    );
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: result.status === "preview" ? result.preview : { url: result.url },
    };
  },
);

const usagePackCheckoutConfirmAuthed$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.orgRole !== "admin") {
      return adminRequired;
    }
    const bodyResult = await get(
      bodyResultOf(zeroBillingUsagePackCheckoutContract.confirm),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    return await set(
      confirmUsagePackPurchaseForOrg$,
      auth.orgId,
      bodyResult.data.previewToken,
      signal,
    );
  },
);

const usagePackCatalogAuthed$ = command(
  async ({ get }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.orgRole !== "admin") {
      return adminRequired;
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

    const usagePacks = await loadUsagePackCatalog();
    signal.throwIfAborted();
    return { status: 200 as const, body: { usagePacks: [...usagePacks] } };
  },
);

const usagePackCatalog$ = command(async ({ set }, signal: AbortSignal) => {
  if (!optionalEnv("STRIPE_SECRET_KEY")) {
    return providerUnavailable("Billing not configured");
  }

  return await set(
    authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      usagePackCatalogAuthed$,
    ),
    signal,
  );
});

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

const usagePackCheckoutConfirm$ = command(
  async ({ set }, signal: AbortSignal) => {
    if (!optionalEnv("STRIPE_SECRET_KEY")) {
      return providerUnavailable("Billing not configured");
    }
    return await set(
      authRoute(
        { requireOrganization: true, missingOrganizationStatus: 401 },
        usagePackCheckoutConfirmAuthed$,
      ),
      signal,
    );
  },
);

const usagePackManagementAccess$ = command(
  async ({ get }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.orgRole !== "admin") {
      return { allowed: false as const, response: adminRequired };
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
      return {
        allowed: false as const,
        response: usagePackManagementDisabled,
      };
    }
    return { allowed: true as const, auth };
  },
);

const usagePackManagementGetAuthed$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const access = await set(usagePackManagementAccess$, signal);
    if (!access.allowed) {
      return access.response;
    }
    const db = get(db$);
    const [subscriptionSchema, changeSchema, memberAdditionSchema] =
      await Promise.all([
        usagePackSubscriptionSchemaAvailable(db),
        usagePackAllocationChangeSchemaAvailable(db),
        usagePackMemberAdditionSchemaAvailable(db),
      ]);
    signal.throwIfAborted();
    if (!subscriptionSchema || !changeSchema) {
      return providerUnavailable("Usage pack billing is not ready");
    }
    const management = await getUsagePackManagement(
      db,
      access.auth.orgId,
      memberAdditionSchema,
    );
    signal.throwIfAborted();
    if (!management) {
      return notFound("Usage pack subscription not found");
    }
    return { status: 200 as const, body: management };
  },
);

const usagePackChangePreviewAuthed$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const access = await set(usagePackManagementAccess$, signal);
    if (!access.allowed) {
      return access.response;
    }
    const bodyResult = await get(
      bodyResultOf(zeroBillingUsagePackManagementContract.previewChange),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const previewEnabled = await set(
      billingPurchasePreviewEnabled$,
      {
        orgId: access.auth.orgId,
        userId: access.auth.userId,
        requested: bodyResult.data.supportsInAppPreview === true,
      },
      signal,
    );
    if (
      previewEnabled &&
      (!bodyResult.data.returnUrl ||
        !billingRedirectAllowed(bodyResult.data.returnUrl))
    ) {
      return badRequestMessage(
        "returnUrl must match the platform origin for in-app billing",
      );
    }
    const db = set(writeDb$);
    const [subscriptionSchema, changeSchema] = await Promise.all([
      usagePackSubscriptionSchemaAvailable(db),
      usagePackAllocationChangeSchemaAvailable(db),
    ]);
    signal.throwIfAborted();
    if (!subscriptionSchema || !changeSchema) {
      return providerUnavailable("Usage pack billing is not ready");
    }
    const result = await previewUsagePackAllocationChange(
      db,
      {
        orgId: access.auth.orgId,
        userId: bodyResult.data.memberId,
        targetUsagePackUsd: bodyResult.data.targetUsagePackUsd,
      },
      signal,
    );
    if (result.status === "not_found") {
      return notFound("Usage pack allocation not found");
    }
    if (result.status === "same_package") {
      return badRequestMessage("Member already has this usage pack");
    }
    if (result.status === "conflict") {
      return conflict("Another usage pack billing change is in progress");
    }
    if (
      result.preview.immediateAmountCents > 0 &&
      previewEnabled &&
      bodyResult.data.returnUrl
    ) {
      const billing = await activeUsagePackBillingContext(
        db,
        access.auth.orgId,
      );
      signal.throwIfAborted();
      if (!billing) {
        return notFound("Usage pack subscription not found");
      }
      const route = await routeBillingPurchasePreview(
        {
          stripe: getStripeClient(),
          orgId: access.auth.orgId,
          customerId: billing.stripeCustomerId,
          subscriptionId: billing.stripeSubscriptionId,
          operation: "usage_pack_allocation",
          operationId: result.preview.changeId,
          returnUrl: bodyResult.data.returnUrl,
        },
        signal,
      );
      if (route.kind === "checkout") {
        await discardUsagePackAllocationChangePreviewForPaymentSetup(db, {
          orgId: access.auth.orgId,
          changeId: result.preview.changeId,
        });
        signal.throwIfAborted();
        return {
          status: 200 as const,
          body: { ...result.preview, checkoutUrl: route.url },
        };
      }
      return {
        status: 200 as const,
        body: {
          ...result.preview,
          paymentMethodPreviewToken: route.paymentMethodPreviewToken,
        },
      };
    }
    return { status: 200 as const, body: result.preview };
  },
);

const usagePackChangeConfirmAuthed$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const access = await set(usagePackManagementAccess$, signal);
    if (!access.allowed) {
      return access.response;
    }
    const bodyResult = await get(
      bodyResultOf(zeroBillingUsagePackManagementContract.confirmChange),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const { changeId } = get(
      pathParamsOf(zeroBillingUsagePackManagementContract.confirmChange),
    );
    const db = set(writeDb$);
    const [subscriptionSchema, changeSchema] = await Promise.all([
      usagePackSubscriptionSchemaAvailable(db),
      usagePackAllocationChangeSchemaAvailable(db),
    ]);
    signal.throwIfAborted();
    if (!subscriptionSchema || !changeSchema) {
      return providerUnavailable("Usage pack billing is not ready");
    }
    let paymentMethod: BillingPurchasePaymentMethod | undefined;
    if (bodyResult.data.paymentMethodPreviewToken) {
      const preview = parseBillingPaymentMethodPreviewToken(
        bodyResult.data.paymentMethodPreviewToken,
      );
      const billing = await activeUsagePackBillingContext(
        db,
        access.auth.orgId,
      );
      signal.throwIfAborted();
      if (
        !preview ||
        !billing ||
        preview.operation !== "usage_pack_allocation" ||
        preview.operationId !== changeId ||
        preview.orgId !== access.auth.orgId ||
        preview.customerId !== billing.stripeCustomerId ||
        preview.subscriptionId !== billing.stripeSubscriptionId ||
        new Date(preview.expiresAt) <= nowDate()
      ) {
        return conflict("Usage pack change preview is no longer valid");
      }
      const revalidated = await revalidateBillingPurchase(
        {
          stripe: getStripeClient(),
          orgId: access.auth.orgId,
          customerId: preview.customerId,
          subscriptionId: preview.subscriptionId,
          paymentMethodId: preview.paymentMethodId,
          operation: preview.operation,
          operationId: preview.operationId,
          returnUrl: preview.returnUrl,
        },
        signal,
      );
      if (revalidated.kind === "invalid_preview") {
        return conflict("Usage pack change preview is no longer valid");
      }
      if (revalidated.kind === "checkout") {
        await discardUsagePackAllocationChangePreviewForPaymentSetup(db, {
          orgId: access.auth.orgId,
          changeId,
        });
        signal.throwIfAborted();
        return {
          status: 200 as const,
          body: {
            status: "checkout_required" as const,
            checkoutUrl: revalidated.url,
          },
        };
      }
      paymentMethod = revalidated;
    }
    const result = await confirmUsagePackAllocationChange(
      db,
      {
        orgId: access.auth.orgId,
        changeId,
        paymentMethod,
      },
      signal,
    );
    if (result.status === "not_found") {
      return notFound("Usage pack change not found");
    }
    if (result.status === "expired") {
      return badRequestMessage("Usage pack change preview expired");
    }
    if (result.status === "conflict") {
      return conflict("Usage pack allocation changed; create a new preview");
    }
    return { status: 200 as const, body: result.response };
  },
);

async function usagePackMigrationSchemasAvailable(
  db: Parameters<typeof usagePackSubscriptionSchemaAvailable>[0],
): Promise<boolean> {
  const [subscriptionSchema, invitationSchema] = await Promise.all([
    usagePackSubscriptionSchemaAvailable(db),
    usagePackInvitationPurchaseSchemaAvailable(db),
  ]);
  return subscriptionSchema && invitationSchema;
}

const usagePackMigrationGetAuthed$ = command(
  async ({ set }, signal: AbortSignal) => {
    const access = await set(usagePackManagementAccess$, signal);
    if (!access.allowed) {
      return access.response;
    }
    const db = set(writeDb$);
    if (!(await usagePackMigrationSchemasAvailable(db))) {
      return providerUnavailable("Usage pack migration is not ready");
    }
    signal.throwIfAborted();
    const result = await getUsagePackMigrationState(db, access.auth.orgId);
    signal.throwIfAborted();
    if (result.status === "not_found") {
      return notFound("Legacy subscription migration is not available");
    }
    if (result.status === "conflict") {
      return conflict("Another subscription update is in progress");
    }
    return { status: 200 as const, body: result.state };
  },
);

const usagePackMigrationPreviewAuthed$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const access = await set(usagePackManagementAccess$, signal);
    if (!access.allowed) {
      return access.response;
    }
    const bodyResult = await get(
      bodyResultOf(zeroBillingUsagePackMigrationContract.preview),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const db = set(writeDb$);
    if (!(await usagePackMigrationSchemasAvailable(db))) {
      return providerUnavailable("Usage pack migration is not ready");
    }
    const clerk = get(clerk$);
    const [memberships, invitations] = await Promise.all([
      listAllOrganizationMemberships(clerk.organizations, access.auth.orgId),
      listAllPendingOrganizationInvitations(
        clerk.organizations,
        access.auth.orgId,
      ),
    ]);
    signal.throwIfAborted();
    const result = await previewUsagePackSubscriptionMigration(
      db,
      {
        orgId: access.auth.orgId,
        targetTier: bodyResult.data.targetTier,
        memberUsagePacks: bodyResult.data.memberUsagePacks,
        owners: usagePackMigrationOwners(
          memberships,
          invitations,
          access.auth.userId,
        ),
      },
      signal,
    );
    if (result.status === "not_found") {
      return notFound("Eligible legacy subscription not found");
    }
    if (result.status === "owners_changed") {
      return badRequestMessage(
        "Organization members changed; refresh billing and try again",
      );
    }
    if (result.status === "conflict") {
      return conflict("Another subscription update is in progress");
    }
    return { status: 200 as const, body: result.preview };
  },
);

const usagePackMigrationConfirmAuthed$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const access = await set(usagePackManagementAccess$, signal);
    if (!access.allowed) {
      return access.response;
    }
    const bodyResult = await get(
      bodyResultOf(zeroBillingUsagePackMigrationContract.confirm),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const { migrationId } = get(
      pathParamsOf(zeroBillingUsagePackMigrationContract.confirm),
    );
    const db = set(writeDb$);
    if (!(await usagePackMigrationSchemasAvailable(db))) {
      return providerUnavailable("Usage pack migration is not ready");
    }
    const clerk = get(clerk$);
    const [memberships, invitations] = await Promise.all([
      listAllOrganizationMemberships(clerk.organizations, access.auth.orgId),
      listAllPendingOrganizationInvitations(
        clerk.organizations,
        access.auth.orgId,
      ),
    ]);
    signal.throwIfAborted();
    const ownerIds = usagePackMigrationOwners(
      memberships,
      invitations,
      access.auth.userId,
    ).map((owner) => {
      return "userId" in owner ? owner.userId : owner.invitationId;
    });
    const result = await confirmUsagePackSubscriptionMigration(
      db,
      {
        orgId: access.auth.orgId,
        migrationId,
        ownerIds,
      },
      signal,
    );
    if (result.status === "not_found") {
      return notFound("Usage pack migration not found");
    }
    if (result.status === "expired") {
      return badRequestMessage("Usage pack migration preview expired");
    }
    if (result.status === "owners_changed") {
      return conflict(
        "Organization members changed; create a new migration preview",
      );
    }
    if (result.status === "conflict") {
      return conflict("Usage pack migration is no longer available");
    }
    return { status: 200 as const, body: result.response };
  },
);

const usagePackMigrationRevisionPreviewAuthed$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const access = await set(usagePackManagementAccess$, signal);
    if (!access.allowed) {
      return access.response;
    }
    const bodyResult = await get(
      bodyResultOf(zeroBillingUsagePackMigrationContract.previewRevision),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const { migrationId } = get(
      pathParamsOf(zeroBillingUsagePackMigrationContract.previewRevision),
    );
    const db = set(writeDb$);
    if (!(await usagePackMigrationSchemasAvailable(db))) {
      return providerUnavailable("Usage pack migration is not ready");
    }
    const clerk = get(clerk$);
    const [memberships, invitations] = await Promise.all([
      listAllOrganizationMemberships(clerk.organizations, access.auth.orgId),
      listAllPendingOrganizationInvitations(
        clerk.organizations,
        access.auth.orgId,
      ),
    ]);
    signal.throwIfAborted();
    const result = await previewUsagePackSubscriptionMigrationRevision(
      db,
      {
        orgId: access.auth.orgId,
        migrationId,
        targetTier: bodyResult.data.targetTier,
        memberUsagePacks: bodyResult.data.memberUsagePacks,
        owners: usagePackMigrationOwners(
          memberships,
          invitations,
          access.auth.userId,
        ),
      },
      signal,
    );
    if (result.status === "not_found") {
      return notFound("Scheduled usage pack migration not found");
    }
    if (result.status === "owners_changed") {
      return badRequestMessage(
        "Organization members changed; refresh billing and try again",
      );
    }
    if (result.status === "same_configuration") {
      return badRequestMessage("The migration configuration is unchanged");
    }
    if (result.status === "conflict") {
      return conflict("Usage pack migration cannot be revised");
    }
    return { status: 200 as const, body: result.preview };
  },
);

const usagePackMigrationRevisionConfirmAuthed$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const access = await set(usagePackManagementAccess$, signal);
    if (!access.allowed) {
      return access.response;
    }
    const bodyResult = await get(
      bodyResultOf(zeroBillingUsagePackMigrationContract.confirmRevision),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const { migrationId } = get(
      pathParamsOf(zeroBillingUsagePackMigrationContract.confirmRevision),
    );
    const db = set(writeDb$);
    if (!(await usagePackMigrationSchemasAvailable(db))) {
      return providerUnavailable("Usage pack migration is not ready");
    }
    const clerk = get(clerk$);
    const [memberships, invitations] = await Promise.all([
      listAllOrganizationMemberships(clerk.organizations, access.auth.orgId),
      listAllPendingOrganizationInvitations(
        clerk.organizations,
        access.auth.orgId,
      ),
    ]);
    signal.throwIfAborted();
    const result = await confirmUsagePackSubscriptionMigrationRevision(
      db,
      {
        orgId: access.auth.orgId,
        migrationId,
        targetTier: bodyResult.data.targetTier,
        memberUsagePacks: bodyResult.data.memberUsagePacks,
        owners: usagePackMigrationOwners(
          memberships,
          invitations,
          access.auth.userId,
        ),
        previewToken: bodyResult.data.previewToken,
      },
      signal,
    );
    if (result.status === "not_found") {
      return notFound("Scheduled usage pack migration not found");
    }
    if (result.status === "invalid_preview") {
      return badRequestMessage(
        "Usage pack migration preview is invalid or expired",
      );
    }
    if (result.status === "owners_changed") {
      return conflict(
        "Organization members changed; create a new migration preview",
      );
    }
    if (result.status === "conflict") {
      return conflict("Usage pack migration configuration changed");
    }
    return { status: 200 as const, body: result.response };
  },
);

const usagePackManagementGet$ = command(
  async ({ set }, signal: AbortSignal) => {
    if (!optionalEnv("STRIPE_SECRET_KEY")) {
      return providerUnavailable("Billing not configured");
    }
    return await set(
      authRoute(
        { requireOrganization: true, missingOrganizationStatus: 401 },
        usagePackManagementGetAuthed$,
      ),
      signal,
    );
  },
);

const usagePackChangePreview$ = command(
  async ({ set }, signal: AbortSignal) => {
    if (!optionalEnv("STRIPE_SECRET_KEY")) {
      return providerUnavailable("Billing not configured");
    }
    return await set(
      authRoute(
        { requireOrganization: true, missingOrganizationStatus: 401 },
        usagePackChangePreviewAuthed$,
      ),
      signal,
    );
  },
);

const usagePackChangeConfirm$ = command(
  async ({ set }, signal: AbortSignal) => {
    if (!optionalEnv("STRIPE_SECRET_KEY")) {
      return providerUnavailable("Billing not configured");
    }
    return await set(
      authRoute(
        { requireOrganization: true, missingOrganizationStatus: 401 },
        usagePackChangeConfirmAuthed$,
      ),
      signal,
    );
  },
);

const usagePackSubscriptionChangePreviewAuthed$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const access = await set(usagePackManagementAccess$, signal);
    if (!access.allowed) {
      return access.response;
    }
    const bodyResult = await get(
      bodyResultOf(
        zeroBillingUsagePackManagementContract.previewSubscriptionChange,
      ),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const previewEnabled = await set(
      billingPurchasePreviewEnabled$,
      {
        orgId: access.auth.orgId,
        userId: access.auth.userId,
        requested: bodyResult.data.supportsInAppPreview === true,
      },
      signal,
    );
    if (
      previewEnabled &&
      (!bodyResult.data.returnUrl ||
        !billingRedirectAllowed(bodyResult.data.returnUrl))
    ) {
      return badRequestMessage(
        "returnUrl must match the platform origin for in-app billing",
      );
    }
    const db = set(writeDb$);
    const [
      subscriptionSchema,
      changeSchema,
      subscriptionChangeSchema,
      memberAdditionSchema,
    ] = await Promise.all([
      usagePackSubscriptionSchemaAvailable(db),
      usagePackAllocationChangeSchemaAvailable(db),
      usagePackSubscriptionChangeSchemaAvailable(db),
      usagePackMemberAdditionSchemaAvailable(db),
    ]);
    signal.throwIfAborted();
    if (!subscriptionSchema || !changeSchema || !subscriptionChangeSchema) {
      return providerUnavailable("Usage pack billing is not ready");
    }
    const management = await getUsagePackManagement(db, access.auth.orgId);
    signal.throwIfAborted();
    if (!management) {
      return notFound("Usage pack subscription not found");
    }
    const memberValidation = await validateUsagePackSubscriptionMembers(
      {
        clerk: get(clerk$),
        orgId: access.auth.orgId,
        memberUsagePacks: bodyResult.data.memberUsagePacks,
        allocatedMemberIds: management.allocations.map((allocation) => {
          return allocation.memberId;
        }),
        memberAdditionSchemaAvailable: memberAdditionSchema,
      },
      signal,
    );
    if (memberValidation === "member_additions_unavailable") {
      return providerUnavailable("Usage pack member additions are not ready");
    }
    if (memberValidation === "members_changed") {
      return badRequestMessage(
        "Organization members changed; refresh billing and try again",
      );
    }
    const result = await previewUsagePackSubscriptionChange(
      db,
      {
        orgId: access.auth.orgId,
        targetTier: bodyResult.data.targetTier,
        memberUsagePacks: bodyResult.data.memberUsagePacks,
      },
      signal,
    );
    if (result.status === "not_found") {
      return notFound("Usage pack subscription not found");
    }
    if (result.status === "same_configuration") {
      return badRequestMessage("The subscription configuration is unchanged");
    }
    if (result.status === "invalid_members") {
      return badRequestMessage(
        "Organization members changed; refresh billing and try again",
      );
    }
    if (result.status === "conflict") {
      return conflict("Another usage pack billing change is in progress");
    }
    if (
      result.preview.immediateAmountCents > 0 &&
      previewEnabled &&
      bodyResult.data.returnUrl
    ) {
      const paymentRoute = await routeUsagePackSubscriptionChangePayment(
        {
          db,
          orgId: access.auth.orgId,
          preview: result.preview,
          returnUrl: bodyResult.data.returnUrl,
        },
        signal,
      );
      if (paymentRoute.kind === "not_found") {
        return notFound("Usage pack subscription not found");
      }
      return { status: 200 as const, body: paymentRoute.body };
    }
    return { status: 200 as const, body: result.preview };
  },
);

const usagePackSubscriptionChangeConfirmAuthed$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const access = await set(usagePackManagementAccess$, signal);
    if (!access.allowed) {
      return access.response;
    }
    const bodyResult = await get(
      bodyResultOf(
        zeroBillingUsagePackManagementContract.confirmSubscriptionChange,
      ),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const db = set(writeDb$);
    const [subscriptionSchema, changeSchema, subscriptionChangeSchema] =
      await Promise.all([
        usagePackSubscriptionSchemaAvailable(db),
        usagePackAllocationChangeSchemaAvailable(db),
        usagePackSubscriptionChangeSchemaAvailable(db),
      ]);
    signal.throwIfAborted();
    if (!subscriptionSchema || !changeSchema || !subscriptionChangeSchema) {
      return providerUnavailable("Usage pack billing is not ready");
    }
    let paymentMethod: BillingPurchasePaymentMethod | undefined;
    if (bodyResult.data.paymentMethodPreviewToken) {
      const preview = parseBillingPaymentMethodPreviewToken(
        bodyResult.data.paymentMethodPreviewToken,
      );
      const billing = await activeUsagePackBillingContext(
        db,
        access.auth.orgId,
      );
      signal.throwIfAborted();
      if (
        !preview ||
        !billing ||
        preview.operation !== "usage_pack_subscription" ||
        preview.operationId !== bodyResult.data.changeId ||
        preview.orgId !== access.auth.orgId ||
        preview.customerId !== billing.stripeCustomerId ||
        preview.subscriptionId !== billing.stripeSubscriptionId ||
        new Date(preview.expiresAt) <= nowDate()
      ) {
        return conflict("Usage pack subscription preview is no longer valid");
      }
      const revalidated = await revalidateBillingPurchase(
        {
          stripe: getStripeClient(),
          orgId: access.auth.orgId,
          customerId: preview.customerId,
          subscriptionId: preview.subscriptionId,
          paymentMethodId: preview.paymentMethodId,
          operation: preview.operation,
          operationId: preview.operationId,
          returnUrl: preview.returnUrl,
        },
        signal,
      );
      if (revalidated.kind === "invalid_preview") {
        return conflict("Usage pack subscription preview is no longer valid");
      }
      if (revalidated.kind === "checkout") {
        await discardUsagePackSubscriptionChangePreviewForPaymentSetup(db, {
          orgId: access.auth.orgId,
          changeId: bodyResult.data.changeId,
        });
        signal.throwIfAborted();
        return {
          status: 200 as const,
          body: {
            status: "checkout_required" as const,
            checkoutUrl: revalidated.url,
          },
        };
      }
      paymentMethod = revalidated;
    }
    const result = await confirmUsagePackSubscriptionChange(
      db,
      {
        orgId: access.auth.orgId,
        changeId: bodyResult.data.changeId,
        paymentMethod,
      },
      signal,
    );
    if (result.status === "not_found") {
      return notFound("Usage pack subscription not found");
    }
    if (result.status === "expired") {
      return badRequestMessage("Usage pack subscription preview expired");
    }
    if (result.status === "conflict") {
      return conflict("Another usage pack billing change is in progress");
    }
    return { status: 200 as const, body: result.response };
  },
);

const usagePackSubscriptionChangePreview$ = command(
  async ({ set }, signal: AbortSignal) => {
    if (!optionalEnv("STRIPE_SECRET_KEY")) {
      return providerUnavailable("Billing not configured");
    }
    return await set(
      authRoute(
        { requireOrganization: true, missingOrganizationStatus: 401 },
        usagePackSubscriptionChangePreviewAuthed$,
      ),
      signal,
    );
  },
);

const usagePackMigrationGet$ = command(async ({ set }, signal: AbortSignal) => {
  if (!optionalEnv("STRIPE_SECRET_KEY")) {
    return providerUnavailable("Billing not configured");
  }
  return await set(
    authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      usagePackMigrationGetAuthed$,
    ),
    signal,
  );
});

const usagePackMigrationPreview$ = command(
  async ({ set }, signal: AbortSignal) => {
    if (!optionalEnv("STRIPE_SECRET_KEY")) {
      return providerUnavailable("Billing not configured");
    }
    return await set(
      authRoute(
        { requireOrganization: true, missingOrganizationStatus: 401 },
        usagePackMigrationPreviewAuthed$,
      ),
      signal,
    );
  },
);

const usagePackMigrationConfirm$ = command(
  async ({ set }, signal: AbortSignal) => {
    if (!optionalEnv("STRIPE_SECRET_KEY")) {
      return providerUnavailable("Billing not configured");
    }
    return await set(
      authRoute(
        { requireOrganization: true, missingOrganizationStatus: 401 },
        usagePackMigrationConfirmAuthed$,
      ),
      signal,
    );
  },
);

const usagePackMigrationRevisionPreview$ = command(
  async ({ set }, signal: AbortSignal) => {
    if (!optionalEnv("STRIPE_SECRET_KEY")) {
      return providerUnavailable("Billing not configured");
    }
    return await set(
      authRoute(
        { requireOrganization: true, missingOrganizationStatus: 401 },
        usagePackMigrationRevisionPreviewAuthed$,
      ),
      signal,
    );
  },
);

const usagePackMigrationRevisionConfirm$ = command(
  async ({ set }, signal: AbortSignal) => {
    if (!optionalEnv("STRIPE_SECRET_KEY")) {
      return providerUnavailable("Billing not configured");
    }
    return await set(
      authRoute(
        { requireOrganization: true, missingOrganizationStatus: 401 },
        usagePackMigrationRevisionConfirmAuthed$,
      ),
      signal,
    );
  },
);

const usagePackSubscriptionChangeConfirm$ = command(
  async ({ set }, signal: AbortSignal) => {
    if (!optionalEnv("STRIPE_SECRET_KEY")) {
      return providerUnavailable("Billing not configured");
    }
    return await set(
      authRoute(
        { requireOrganization: true, missingOrganizationStatus: 401 },
        usagePackSubscriptionChangeConfirmAuthed$,
      ),
      signal,
    );
  },
);

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

export const billingCheckoutRoutes: readonly RouteEntry[] = [
  {
    route: zeroBillingCheckoutContract.create,
    handler: checkout$,
  },
  {
    route: zeroBillingCheckoutContract.confirm,
    handler: checkoutConfirm$,
  },
  {
    route: zeroBillingCheckoutContract.complete,
    handler: checkoutComplete$,
  },
  {
    route: zeroBillingUsagePackCheckoutContract.create,
    handler: usagePackCheckout$,
  },
  {
    route: zeroBillingUsagePackCheckoutContract.confirm,
    handler: usagePackCheckoutConfirm$,
  },
  {
    route: zeroBillingUsagePackCatalogContract.get,
    handler: usagePackCatalog$,
  },
  {
    route: zeroBillingUsagePackManagementContract.get,
    handler: usagePackManagementGet$,
  },
  {
    route: zeroBillingUsagePackManagementContract.previewChange,
    handler: usagePackChangePreview$,
  },
  {
    route: zeroBillingUsagePackManagementContract.confirmChange,
    handler: usagePackChangeConfirm$,
  },
  {
    route: zeroBillingUsagePackManagementContract.previewSubscriptionChange,
    handler: usagePackSubscriptionChangePreview$,
  },
  {
    route: zeroBillingUsagePackManagementContract.confirmSubscriptionChange,
    handler: usagePackSubscriptionChangeConfirm$,
  },
  {
    route: zeroBillingUsagePackMigrationContract.get,
    handler: usagePackMigrationGet$,
  },
  {
    route: zeroBillingUsagePackMigrationContract.preview,
    handler: usagePackMigrationPreview$,
  },
  {
    route: zeroBillingUsagePackMigrationContract.confirm,
    handler: usagePackMigrationConfirm$,
  },
  {
    route: zeroBillingUsagePackMigrationContract.previewRevision,
    handler: usagePackMigrationRevisionPreview$,
  },
  {
    route: zeroBillingUsagePackMigrationContract.confirmRevision,
    handler: usagePackMigrationRevisionConfirm$,
  },
];
