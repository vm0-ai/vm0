import { command } from "ccstate";
import { zeroOrgMembershipRequestsContract } from "@vm0/api-contracts/contracts/zero-org-members";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import {
  acceptMembershipRequest$,
  rejectMembershipRequest$,
} from "../services/zero-org-membership-requests.service";
import type { RouteEntry } from "../route";

const adminRequired = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Access denied",
      code: "FORBIDDEN" as const,
    }),
  }),
});

const clerkFailed = Object.freeze({
  status: 400 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Invalid request",
      code: "BAD_REQUEST" as const,
    }),
  }),
});

const acceptBody$ = bodyResultOf(zeroOrgMembershipRequestsContract.accept);
const rejectBody$ = bodyResultOf(zeroOrgMembershipRequestsContract.reject);

const acceptInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const body = await get(acceptBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }

  const result = await set(
    acceptMembershipRequest$,
    {
      orgId: auth.orgId,
      role: auth.orgRole,
      requestId: body.data.requestId,
    },
    signal,
  );
  signal.throwIfAborted();

  if (result.kind === "forbidden") {
    return adminRequired;
  }
  if (result.kind === "clerk_failed") {
    return clerkFailed;
  }
  return {
    status: 200 as const,
    body: { message: "Membership request accepted" },
  };
});

const rejectInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const body = await get(rejectBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }

  const result = await set(
    rejectMembershipRequest$,
    {
      orgId: auth.orgId,
      role: auth.orgRole,
      requestId: body.data.requestId,
    },
    signal,
  );
  signal.throwIfAborted();

  if (result.kind === "forbidden") {
    return adminRequired;
  }
  if (result.kind === "clerk_failed") {
    return clerkFailed;
  }
  return {
    status: 200 as const,
    body: { message: "Membership request rejected" },
  };
});

export const zeroOrgMembershipRequestsRoutes: readonly RouteEntry[] = [
  {
    route: zeroOrgMembershipRequestsContract.accept,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      acceptInner$,
    ),
  },
  {
    route: zeroOrgMembershipRequestsContract.reject,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      rejectInner$,
    ),
  },
];
