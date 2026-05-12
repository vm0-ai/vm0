import { command } from "ccstate";
import { zeroOrgMembersContract } from "@vm0/api-contracts/contracts/zero-org-members";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import {
  removeZeroOrgMember$,
  updateZeroOrgMemberRole$,
} from "../services/zero-org-data.service";
import type { RouteEntry } from "../route";

const updateRoleBody$ = bodyResultOf(zeroOrgMembersContract.updateRole);
const removeMemberBody$ = bodyResultOf(zeroOrgMembersContract.removeMember);

const updateRoleInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const body = await get(updateRoleBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }

  const result = await set(
    updateZeroOrgMemberRole$,
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
      removeZeroOrgMember$,
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

export const zeroOrgMembersRoutes: readonly RouteEntry[] = [
  {
    route: zeroOrgMembersContract.updateRole,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      updateRoleInner$,
    ),
  },
  {
    route: zeroOrgMembersContract.removeMember,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      removeMemberInner$,
    ),
  },
];
