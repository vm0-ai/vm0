import { computed, type Computed } from "ccstate";

import { createClerkClient } from "@clerk/backend";
import { verifyWebhook } from "@clerk/backend/webhooks";
import { singleton } from "../../lib/singleton";
import { env } from "../../lib/env";

/**
 * Clerk gateway. This module is the only place `@clerk/backend` is resolved:
 * it belongs to `tsconfig.gateways.json`, so the SDK declaration surface is
 * parsed once in that small program instead of inside the core one, which is
 * what sets the CI peak RSS for apps/api (same move as `@aws-sdk/*` in
 * PR #25714).
 *
 * Everything exported below is a vm0-owned type; that is what keeps the
 * emitted `.d.ts` free of Clerk types. The mirrored client covers exactly the
 * surface callers use today - widening it is fine, naming a Clerk type in an
 * exported signature is not.
 */

export interface ClerkPaginated<T> {
  readonly data: readonly T[];
  readonly totalCount: number;
}

export interface ClerkEmailAddress {
  readonly id: string;
  readonly emailAddress: string;
}

export interface ClerkUser {
  readonly id: string;
  readonly emailAddresses: readonly ClerkEmailAddress[];
  readonly primaryEmailAddressId: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly username: string | null;
  readonly imageUrl: string;
  readonly privateMetadata: Record<string, unknown>;
}

export interface ClerkOrganization {
  readonly id: string;
  readonly name: string;
  readonly slug: string | null;
  readonly imageUrl: string;
  readonly hasImage: boolean;
  readonly createdAt: number;
}

export interface ClerkOrganizationMembershipPublicUserData {
  readonly userId: string;
}

export interface ClerkOrganizationMembership {
  readonly id: string;
  readonly role: string;
  readonly createdAt: number;
  readonly organization: ClerkOrganization;
  readonly publicUserData?: ClerkOrganizationMembershipPublicUserData | null;
}

export interface ClerkOrganizationInvitation {
  readonly id: string;
  readonly emailAddress: string;
  readonly role: string;
  readonly createdAt: number;
}

export type ClerkOrganizationInvitationStatus =
  | "pending"
  | "accepted"
  | "revoked"
  | "expired";

export interface ClerkUsersApi {
  getUserList(params?: {
    userId?: string[];
    emailAddress?: string[];
    limit?: number;
    offset?: number;
  }): Promise<ClerkPaginated<ClerkUser>>;
  getOrganizationMembershipList(params: {
    userId: string;
    limit?: number;
    offset?: number;
  }): Promise<ClerkPaginated<ClerkOrganizationMembership>>;
  updateUserMetadata(
    userId: string,
    params: {
      publicMetadata?: Record<string, unknown>;
      privateMetadata?: Record<string, unknown>;
    },
  ): Promise<ClerkUser>;
}

export interface ClerkOrganizationsApi {
  getOrganization(params: {
    organizationId: string;
  }): Promise<ClerkOrganization>;
  getOrganizationMembershipList(params: {
    organizationId: string;
    limit?: number;
    offset?: number;
  }): Promise<ClerkPaginated<ClerkOrganizationMembership>>;
  getOrganizationInvitationList(params: {
    organizationId: string;
    status?: ClerkOrganizationInvitationStatus[];
    limit?: number;
    offset?: number;
  }): Promise<ClerkPaginated<ClerkOrganizationInvitation>>;
  createOrganizationInvitation(params: {
    organizationId: string;
    emailAddress: string;
    inviterUserId?: string;
    role: string;
    redirectUrl?: string;
    expiresInDays?: number;
    privateMetadata?: Record<string, unknown>;
  }): Promise<ClerkOrganizationInvitation>;
  revokeOrganizationInvitation(params: {
    organizationId: string;
    invitationId: string;
    requestingUserId?: string;
  }): Promise<ClerkOrganizationInvitation>;
  updateOrganizationMembership(params: {
    organizationId: string;
    userId: string;
    role: string;
  }): Promise<ClerkOrganizationMembership>;
  deleteOrganizationMembership(params: {
    organizationId: string;
    userId: string;
  }): Promise<ClerkOrganizationMembership>;
  updateOrganization(
    organizationId: string,
    params: { name?: string },
  ): Promise<ClerkOrganization>;
  updateOrganizationLogo(
    organizationId: string,
    params: { file: Blob | File; uploaderUserId?: string },
  ): Promise<ClerkOrganization>;
  deleteOrganization(organizationId: string): Promise<ClerkOrganization>;
}

export interface ClerkSignInTokensApi {
  createSignInToken(params: {
    userId: string;
    expiresInSeconds: number;
  }): Promise<{ readonly token: string }>;
}

export interface ClerkMachineToMachineApi {
  createToken(params: {
    machineSecretKey: string;
    secondsUntilExpiration?: number;
    minRemainingTtlSeconds?: number;
  }): Promise<{ readonly token?: string }>;
}

export interface ClerkClient {
  readonly users: ClerkUsersApi;
  readonly organizations: ClerkOrganizationsApi;
  readonly signInTokens: ClerkSignInTokensApi;
  readonly m2m: ClerkMachineToMachineApi;
}

/** Session identity as the API models it, independent of Clerk's auth object. */
export interface ClerkSessionIdentity {
  readonly userId: string;
  readonly orgId: string | null;
  readonly orgRole: string | null;
}

/** The only two fields the Clerk webhook route reads off an event. */
export interface ClerkWebhookEvent {
  readonly type: string;
  readonly data: unknown;
}

const clerkSdk = singleton(() => {
  return createClerkClient({
    secretKey: env("CLERK_SECRET_KEY"),
    publishableKey: env("CLERK_PUBLISHABLE_KEY"),
  });
});

export const clerk$: Computed<ClerkClient> = computed((): ClerkClient => {
  return clerkSdk();
});

export type OrganizationMembershipList =
  ClerkPaginated<ClerkOrganizationMembership>;

export function membershipsByUserId(
  userId: string,
  limit = 100,
): Computed<Promise<OrganizationMembershipList>> {
  return computed((get) => {
    return get(clerk$).users.getOrganizationMembershipList({
      userId,
      limit,
    });
  });
}

/**
 * Clerk's `RequestState` is a wide union whose members disagree about what
 * `toAuth()` returns, so it is collapsed here rather than mirrored: callers
 * only need the signed-in identity, or nothing.
 */
export async function authenticateClerkSession(
  request: Request,
): Promise<ClerkSessionIdentity | null> {
  const requestState = await clerkSdk().authenticateRequest(request, {
    acceptsToken: "session_token",
  });

  if (!requestState.isAuthenticated) {
    return null;
  }

  const auth = requestState.toAuth();
  return {
    userId: auth.userId,
    orgId: auth.orgId ?? null,
    orgRole: auth.orgRole ?? null,
  };
}

export async function verifyClerkWebhook(
  request: Request,
  options: { readonly signingSecret?: string },
): Promise<ClerkWebhookEvent> {
  return await verifyWebhook(request, options);
}
