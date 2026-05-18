import { command } from "ccstate";
import { zeroOrgInviteContract } from "@vm0/api-contracts/contracts/zero-org-members";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { clerk$ } from "../external/clerk";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route";

const adminRequired = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Access denied",
      code: "FORBIDDEN",
    }),
  }),
});

const inviteBody$ = bodyResultOf(zeroOrgInviteContract.invite);

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

  // Clerk side effect: sends the invitation email server-side.
  const client = get(clerk$);
  await client.organizations.createOrganizationInvitation({
    organizationId: auth.orgId,
    emailAddress: body.data.email,
    inviterUserId: auth.userId,
    role: body.data.role === "admin" ? "org:admin" : "org:member",
  });
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: { message: `Invitation sent to ${body.data.email}` },
  };
});

const revokeBody$ = bodyResultOf(zeroOrgInviteContract.revoke);

const revokeInner$ = command(async ({ get }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (auth.orgRole !== "admin") {
    return adminRequired;
  }

  const body = await get(revokeBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }

  // Clerk side effect: revokes the pending invitation server-side.
  const client = get(clerk$);
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
];
