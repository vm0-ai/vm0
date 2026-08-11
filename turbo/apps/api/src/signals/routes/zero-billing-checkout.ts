import { command } from "ccstate";
import {
  zeroBillingCheckoutContract,
  zeroBillingUsagePackCatalogContract,
  zeroBillingUsagePackCheckoutContract,
  zeroBillingUsagePackManagementContract,
  zeroBillingUsagePackMigrationContract,
  type MemberUsagePack,
  type UsagePackCatalogItem,
} from "@vm0/api-contracts/contracts/zero-billing";
import { adAttributionMetadataSchema } from "@vm0/api-contracts/contracts/zero-attribution";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { eq } from "drizzle-orm";

import { optionalEnv } from "../../lib/env";
import { billingRedirectAllowed } from "../../lib/billing-redirect";
import { logger } from "../../lib/log";
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
import { db$, writeDb$ } from "../external/db";
import {
  activePriceId,
  activeUsagePackPlanPriceId,
  activeUsagePackPriceId,
  completeCheckoutSession$,
  checkoutTierConflictMessage,
  checkoutWouldReplaceWithSameOrLowerTier,
  createCheckoutSession$,
} from "../services/zero-billing-checkout.service";
import {
  createUsagePackCheckoutSession$,
  loadUsagePackCatalog,
  usagePackSubscriptionSchemaAvailable,
  type UsagePackCheckoutAllocation,
} from "../services/usage-pack-subscription.service";
import {
  confirmUsagePackAllocationChange,
  getUsagePackManagement,
  previewUsagePackAllocationChange,
  usagePackAllocationChangeSchemaAvailable,
} from "../services/usage-pack-allocation-change.service";
import {
  confirmUsagePackSubscriptionChange,
  previewUsagePackSubscriptionChange,
  usagePackMemberAdditionSchemaAvailable,
  usagePackSubscriptionChangeSchemaAvailable,
} from "../services/usage-pack-plan-change.service";
import {
  confirmUsagePackSubscriptionMigration,
  getUsagePackMigrationState,
  previewUsagePackSubscriptionMigration,
  usagePackSubscriptionMigrationSchemaAvailable,
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
  const clerk = get(clerk$);
  const storedAttribution = await signupAttributionForUser(
    clerk,
    auth.userId,
    signal,
  );
  const resolvedAttribution = mergeFirstTouchAttribution(
    adAttribution,
    storedAttribution,
  );

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
      adAttribution: resolvedAttribution,
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

    const bodyResult = await get(
      bodyResultOf(zeroBillingUsagePackCheckoutContract.create),
    );
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const { tier, memberUsagePacks, successUrl, cancelUrl, adAttribution } =
      bodyResult.data;
    const clerk = get(clerk$);
    const storedAttribution = await signupAttributionForUser(
      clerk,
      auth.userId,
      signal,
    );
    const resolvedAttribution = mergeFirstTouchAttribution(
      adAttribution,
      storedAttribution,
    );

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
    if (
      metadata?.stripeSubscriptionId &&
      metadata.subscriptionStatus === "active" &&
      (metadata.tier === "pro" || metadata.tier === "team")
    ) {
      return badRequestMessage(
        "Existing subscriptions must migrate before starting usage pack checkout",
      );
    }

    const catalog = await loadUsagePackCatalog();
    signal.throwIfAborted();

    const [memberships, invitations] = await Promise.all([
      listAllOrganizationMemberships(clerk.organizations, auth.orgId),
      listAllPendingOrganizationInvitations(clerk.organizations, auth.orgId),
    ]);
    signal.throwIfAborted();
    const allocations = usagePackCheckoutAllocations(
      memberUsagePacks,
      memberships,
      invitations,
      catalog,
    );
    if (!allocations) {
      return badRequestMessage(
        "Organization members changed; refresh billing and try again",
      );
    }

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
        allocations,
        successUrl,
        cancelUrl,
        adAttribution: resolvedAttribution,
      },
      signal,
    );
    signal.throwIfAborted();
    return { status: 200 as const, body: { url } };
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
    const result = await confirmUsagePackAllocationChange(
      db,
      {
        orgId: access.auth.orgId,
        changeId,
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
  const [subscriptionSchema, invitationSchema, migrationSchema] =
    await Promise.all([
      usagePackSubscriptionSchemaAvailable(db),
      usagePackInvitationPurchaseSchemaAvailable(db),
      usagePackSubscriptionMigrationSchemaAvailable(db),
    ]);
  return subscriptionSchema && invitationSchema && migrationSchema;
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
    const allocatedMemberIds = new Set(
      management.allocations.map((allocation) => {
        return allocation.memberId;
      }),
    );
    const addsMember = bodyResult.data.memberUsagePacks.some((selection) => {
      return !allocatedMemberIds.has(selection.memberId);
    });
    if (addsMember) {
      if (!memberAdditionSchema) {
        return providerUnavailable("Usage pack member additions are not ready");
      }
      const clerk = get(clerk$);
      const memberships = await listAllOrganizationMemberships(
        clerk.organizations,
        access.auth.orgId,
      );
      signal.throwIfAborted();
      const activeMemberIds = memberships.map((membership) => {
        const memberId = membership.publicUserData?.userId;
        if (!memberId) {
          throw new Error(
            "Clerk organization membership is missing its user ID",
          );
        }
        return memberId;
      });
      if (
        !memberUsagePackIdsMatch(
          bodyResult.data.memberUsagePacks,
          activeMemberIds,
        )
      ) {
        return badRequestMessage(
          "Organization members changed; refresh billing and try again",
        );
      }
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
    const result = await confirmUsagePackSubscriptionChange(
      db,
      {
        orgId: access.auth.orgId,
        changeId: bodyResult.data.changeId,
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
];
