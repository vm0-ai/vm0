import { command } from "ccstate";
import { zeroOrgInviteContract } from "@okouai/api-contracts/contracts/zero-org-members";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { env, optionalEnv } from "../../lib/env";
import { billingRedirectAllowed } from "../../lib/billing-redirect";
import { nowDate } from "../../lib/time";
import {
  badRequestMessage,
  conflict,
  notFound,
  providerUnavailable,
} from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { clerk$ } from "../external/clerk";
import { db$, writeDb$, type ReadonlyDb } from "../external/db";
import { getStripeClient } from "../external/stripe-client";
import { parseBillingPaymentMethodPreviewToken } from "../services/billing-purchase-preview-token.service";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import { loadOrgPlanCapabilities } from "../services/org-plan-entitlement-read.service";
import {
  confirmUsagePackInvitationPurchase,
  createUsagePackInvitationPreview,
  revokeUsagePackInvitationPurchase,
  usagePackInvitationPurchaseSchemaAvailable,
} from "../services/usage-pack-invitation-purchase.service";
import { activeUsagePackBillingContext } from "../services/usage-pack-subscription.service";
import {
  billingPurchasePreviewEnabled$,
  revalidateBillingPurchase,
  routeBillingPurchasePreview,
  type BillingPurchasePaymentMethod,
} from "../services/billing-payment-method.service";
import type { RouteEntry } from "../route-entry";

const adminRequired = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Access denied",
      code: "FORBIDDEN",
    }),
  }),
});

const memberInvitationUpgradeRequired = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Upgrade to Pro to invite members",
      code: "FORBIDDEN",
    }),
  }),
});

const inviteBody$ = bodyResultOf(zeroOrgInviteContract.invite);

async function usagePackInvitationsEnabled(
  get: Parameters<Parameters<typeof command>[0]>[0]["get"],
  orgId: string,
  userId: string,
): Promise<boolean> {
  const overrides = await get(userFeatureSwitchOverrides(orgId, userId));
  return isFeatureEnabled(FeatureSwitchKey.UsagePackPlans, {
    orgId,
    userId,
    overrides,
  });
}

const inviteInner$ = command(async ({ get }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (auth.orgRole !== "admin") {
    return adminRequired;
  }

  const body = await get(inviteBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }

  if (await usagePackInvitationsEnabled(get, auth.orgId, auth.userId)) {
    signal.throwIfAborted();
    const db = get(db$);
    const capabilities = await loadOrgPlanCapabilities(db, auth.orgId);
    signal.throwIfAborted();
    if (!capabilities?.memberInvitationAllowed) {
      return memberInvitationUpgradeRequired;
    }
    if (capabilities?.memberInviteUsagePackRequired) {
      if (!(await usagePackInvitationPurchaseSchemaAvailable(db))) {
        return providerUnavailable("Usage pack invitations are not ready");
      }
      return conflict(
        "A usage pack must be purchased before inviting this member",
      );
    }
  }

  // Clerk side effect: sends the invitation email server-side.
  const client = get(clerk$);
  await client.organizations.createOrganizationInvitation({
    organizationId: auth.orgId,
    emailAddress: body.data.email,
    inviterUserId: auth.userId,
    role: body.data.role === "admin" ? "org:admin" : "org:member",
    redirectUrl: env("APP_URL"),
  });
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: { message: `Invitation sent to ${body.data.email}` },
  };
});

const revokeBody$ = bodyResultOf(zeroOrgInviteContract.revoke);

const revokeInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (auth.orgRole !== "admin") {
    return adminRequired;
  }

  const body = await get(revokeBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }

  const client = get(clerk$);
  const readDb = get(db$);
  if (await usagePackInvitationPurchaseSchemaAvailable(readDb)) {
    signal.throwIfAborted();
    const result = await revokeUsagePackInvitationPurchase(
      set(writeDb$),
      client,
      {
        orgId: auth.orgId,
        invitationId: body.data.invitationId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (result.status === "accepted") {
      return conflict("The invitation has already been accepted");
    }
    if (result.status === "revoked") {
      return {
        status: 200 as const,
        body: { message: "Invitation revoked and refund initiated" },
      };
    }
  }

  // Legacy invitations remain a direct Clerk operation.
  await client.organizations.revokeOrganizationInvitation({
    organizationId: auth.orgId,
    invitationId: body.data.invitationId,
  });
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: { message: "Invitation revoked" },
  };
});

const purchasePreviewBody$ = bodyResultOf(
  zeroOrgInviteContract.previewPurchase,
);

const purchasePreviewInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.orgRole !== "admin") {
      return adminRequired;
    }
    if (!optionalEnv("STRIPE_SECRET_KEY")) {
      return providerUnavailable("Billing not configured");
    }
    if (!(await usagePackInvitationsEnabled(get, auth.orgId, auth.userId))) {
      return {
        status: 403 as const,
        body: {
          error: {
            message: "Usage pack invitations are not enabled",
            code: "FORBIDDEN",
          },
        },
      };
    }
    signal.throwIfAborted();
    const db = get(db$);
    const capabilities = await loadOrgPlanCapabilities(db, auth.orgId);
    signal.throwIfAborted();
    if (!capabilities?.memberInvitationAllowed) {
      return memberInvitationUpgradeRequired;
    }
    if (!(await usagePackInvitationPurchaseSchemaAvailable(db))) {
      return providerUnavailable("Usage pack invitations are not ready");
    }
    signal.throwIfAborted();
    const body = await get(purchasePreviewBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const previewEnabled = await set(
      billingPurchasePreviewEnabled$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        requested: body.data.supportsInAppPreview === true,
      },
      signal,
    );
    if (
      previewEnabled &&
      (!body.data.returnUrl || !billingRedirectAllowed(body.data.returnUrl))
    ) {
      return badRequestMessage(
        "returnUrl must match the platform origin for in-app billing",
      );
    }
    const result = await createUsagePackInvitationPreview(
      set(writeDb$),
      get(clerk$),
      {
        orgId: auth.orgId,
        inviterUserId: auth.userId,
        email: body.data.email,
        role: body.data.role,
        usagePackUsd: body.data.usagePackUsd,
      },
      signal,
    );
    if (result.status === "not_found") {
      return notFound("Usage pack subscription not found");
    }
    if (result.status === "conflict") {
      return conflict(
        "This invitation cannot be purchased in the current billing state",
      );
    }
    if (previewEnabled && body.data.returnUrl) {
      const billing = await activeUsagePackBillingContext(db, auth.orgId);
      signal.throwIfAborted();
      if (!billing) {
        return notFound("Usage pack subscription not found");
      }
      const route = await routeBillingPurchasePreview(
        {
          stripe: getStripeClient(),
          orgId: auth.orgId,
          customerId: billing.stripeCustomerId,
          subscriptionId: billing.stripeSubscriptionId,
          operation: "usage_pack_invitation",
          operationId: result.preview.purchaseId,
          returnUrl: body.data.returnUrl,
        },
        signal,
      );
      if (route.kind === "checkout") {
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

async function revalidateInvitationPurchasePreview(
  args: {
    readonly db: ReadonlyDb;
    readonly orgId: string;
    readonly purchaseId: string;
    readonly paymentMethodPreviewToken: string;
  },
  signal: AbortSignal,
): Promise<
  | {
      readonly kind: "continue";
      readonly paymentMethod: BillingPurchasePaymentMethod;
    }
  | { readonly kind: "invalid_preview" }
  | { readonly kind: "checkout"; readonly url: string }
> {
  const preview = parseBillingPaymentMethodPreviewToken(
    args.paymentMethodPreviewToken,
  );
  const billing = await activeUsagePackBillingContext(args.db, args.orgId);
  signal.throwIfAborted();
  if (
    !preview ||
    !billing ||
    preview.operation !== "usage_pack_invitation" ||
    preview.operationId !== args.purchaseId ||
    preview.orgId !== args.orgId ||
    preview.customerId !== billing.stripeCustomerId ||
    preview.subscriptionId !== billing.stripeSubscriptionId ||
    new Date(preview.expiresAt) <= nowDate()
  ) {
    return { kind: "invalid_preview" };
  }
  const revalidated = await revalidateBillingPurchase(
    {
      stripe: getStripeClient(),
      orgId: args.orgId,
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
    return { kind: "invalid_preview" };
  }
  return revalidated.kind === "checkout"
    ? { kind: "checkout", url: revalidated.url }
    : { kind: "continue", paymentMethod: revalidated };
}

const purchaseConfirmInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.orgRole !== "admin") {
      return adminRequired;
    }
    if (!optionalEnv("STRIPE_SECRET_KEY")) {
      return providerUnavailable("Billing not configured");
    }
    if (!(await usagePackInvitationsEnabled(get, auth.orgId, auth.userId))) {
      return {
        status: 403 as const,
        body: {
          error: {
            message: "Usage pack invitations are not enabled",
            code: "FORBIDDEN",
          },
        },
      };
    }
    signal.throwIfAborted();
    const db = get(db$);
    const capabilities = await loadOrgPlanCapabilities(db, auth.orgId);
    signal.throwIfAborted();
    if (!capabilities?.memberInvitationAllowed) {
      return memberInvitationUpgradeRequired;
    }
    if (!(await usagePackInvitationPurchaseSchemaAvailable(db))) {
      return providerUnavailable("Usage pack invitations are not ready");
    }
    const body = await get(bodyResultOf(zeroOrgInviteContract.confirmPurchase));
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }
    const { purchaseId } = get(
      pathParamsOf(zeroOrgInviteContract.confirmPurchase),
    );
    let paymentMethod: BillingPurchasePaymentMethod | undefined;
    if (body.data.paymentMethodPreviewToken) {
      const revalidated = await revalidateInvitationPurchasePreview(
        {
          db,
          orgId: auth.orgId,
          purchaseId,
          paymentMethodPreviewToken: body.data.paymentMethodPreviewToken,
        },
        signal,
      );
      if (revalidated.kind === "invalid_preview") {
        return conflict("Invitation purchase preview is no longer valid");
      }
      if (revalidated.kind === "checkout") {
        return {
          status: 200 as const,
          body: {
            status: "checkout_required" as const,
            checkoutUrl: revalidated.url,
          },
        };
      }
      paymentMethod = revalidated.paymentMethod;
    }
    const result = await confirmUsagePackInvitationPurchase(
      set(writeDb$),
      get(clerk$),
      { orgId: auth.orgId, purchaseId, paymentMethod },
      signal,
    );
    if (result.status === "not_found") {
      return notFound("Invitation purchase not found");
    }
    if (result.status === "expired") {
      return badRequestMessage("Invitation purchase preview expired");
    }
    if (result.status === "conflict") {
      return conflict(
        "This invitation cannot be purchased in the current billing state",
      );
    }
    if (result.status === "pending_payment") {
      return {
        status: 200 as const,
        body: {
          status: "pending_payment" as const,
          hostedInvoiceUrl: result.hostedInvoiceUrl,
        },
      };
    }
    return {
      status: 200 as const,
      body: { message: "Invitation purchased and sent" },
    };
  },
);

export const orgInviteRoutes: readonly RouteEntry[] = [
  {
    route: zeroOrgInviteContract.invite,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      inviteInner$,
    ),
  },
  {
    route: zeroOrgInviteContract.revoke,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      revokeInner$,
    ),
  },
  {
    route: zeroOrgInviteContract.previewPurchase,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      purchasePreviewInner$,
    ),
  },
  {
    route: zeroOrgInviteContract.confirmPurchase,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      purchaseConfirmInner$,
    ),
  },
];
