import { command } from "ccstate";
import { zeroOrgInviteContract } from "@vm0/api-contracts/contracts/zero-org-members";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";

import { billingRedirectAllowed } from "../../lib/billing-redirect";
import { env, optionalEnv } from "../../lib/env";
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
import { db$, writeDb$ } from "../external/db";
import { userFeatureSwitchOverrides } from "../services/feature-switches.service";
import { loadOrgPlanCapabilities } from "../services/org-plan-entitlement-read.service";
import {
  confirmUsagePackInvitationPurchase,
  createUsagePackInvitationCheckout,
  createUsagePackInvitationPreview,
  revokeUsagePackInvitationPurchase,
  usagePackInvitationPurchaseSchemaAvailable,
} from "../services/usage-pack-invitation-purchase.service";
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

const purchaseBody$ = bodyResultOf(zeroOrgInviteContract.purchase);
const purchasePreviewBody$ = bodyResultOf(
  zeroOrgInviteContract.previewPurchase,
);

const purchaseInner$ = command(async ({ get, set }, signal: AbortSignal) => {
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
  const readDb = get(db$);
  const capabilities = await loadOrgPlanCapabilities(readDb, auth.orgId);
  signal.throwIfAborted();
  if (!capabilities?.memberInvitationAllowed) {
    return memberInvitationUpgradeRequired;
  }
  if (!(await usagePackInvitationPurchaseSchemaAvailable(readDb))) {
    return providerUnavailable("Usage pack invitations are not ready");
  }
  signal.throwIfAborted();
  const body = await get(purchaseBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  if (
    !billingRedirectAllowed(body.data.successUrl) ||
    !billingRedirectAllowed(body.data.cancelUrl)
  ) {
    return badRequestMessage(
      "successUrl and cancelUrl must match the platform origin",
    );
  }
  const result = await createUsagePackInvitationCheckout(
    set(writeDb$),
    get(clerk$),
    {
      orgId: auth.orgId,
      inviterUserId: auth.userId,
      email: body.data.email,
      role: body.data.role,
      usagePackUsd: body.data.usagePackUsd,
      successUrl: body.data.successUrl,
      cancelUrl: body.data.cancelUrl,
    },
    signal,
  );
  signal.throwIfAborted();
  if (result.status === "not_found") {
    return notFound("Usage pack subscription not found");
  }
  if (result.status === "conflict") {
    return conflict(
      "This invitation cannot be purchased in the current billing state",
    );
  }
  return { status: 200 as const, body: { url: result.url } };
});

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
    return { status: 200 as const, body: result.preview };
  },
);

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
    const { purchaseId } = get(
      pathParamsOf(zeroOrgInviteContract.confirmPurchase),
    );
    const result = await confirmUsagePackInvitationPurchase(
      set(writeDb$),
      get(clerk$),
      { orgId: auth.orgId, purchaseId },
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
    return {
      status: 200 as const,
      body: { message: "Invitation purchased and sent" },
    };
  },
);

export const zeroOrgInviteRoutes: readonly RouteEntry[] = [
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
    route: zeroOrgInviteContract.purchase,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      purchaseInner$,
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
