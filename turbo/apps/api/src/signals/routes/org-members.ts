import { command } from "ccstate";
import { orgMembersContract } from "@okouai/api-contracts/contracts/org-member-routes";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import {
  removeOrgMember$,
  updateOrgMemberRole$,
} from "../services/org-data.service";
import type { RouteEntry } from "../route-entry";

const updateRoleBody$ = bodyResultOf(orgMembersContract.updateRole);
const removeMemberBody$ = bodyResultOf(orgMembersContract.removeMember);

const updateRoleInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const body = await get(updateRoleBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }

  const result = await set(
    updateOrgMemberRole$,
    {
      callerUserId: auth.userId,
      orgId: auth.orgId,
      callerRole: auth.orgRole,
      targetEmail: body.data.email,
      newRole: body.data.role,
    },
    signal,
  );
  signal.throwIfAborted();

  if ("status" in result) {
    return result;
  }

  return { status: 200 as const, body: result };
});

const removeMemberInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const body = await get(removeMemberBody$);
    signal.throwIfAborted();
    if (!body.ok) {
      return body.response;
    }

    const result = await set(
      removeOrgMember$,
      {
        orgId: auth.orgId,
        callerUserId: auth.userId,
        callerRole: auth.orgRole ?? "member",
        email: body.data.email,
      },
      signal,
    );
    signal.throwIfAborted();

    if ("status" in result) {
      return result;
    }

    return { status: 200 as const, body: result };
  },
);

export const orgMembersRoutes: readonly RouteEntry[] = [
  {
    route: orgMembersContract.updateRole,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      updateRoleInner$,
    ),
  },
  {
    route: orgMembersContract.removeMember,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      removeMemberInner$,
    ),
  },
];
