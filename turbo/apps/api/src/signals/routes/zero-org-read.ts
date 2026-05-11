import { command, computed } from "ccstate";
import { zeroOrgContract } from "@vm0/api-contracts/contracts/zero-org";
import { zeroOrgListContract } from "@vm0/api-contracts/contracts/zero-org-list";
import { zeroOrgDomainsContract } from "@vm0/api-contracts/contracts/zero-org-domains";
import { zeroOrgMembersContract } from "@vm0/api-contracts/contracts/zero-org-members";

import { authContext$, organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { notFound } from "../../lib/error";
import type { RouteEntry } from "../route";
import {
  zeroOrgDetail$,
  zeroOrgDomainsList,
  zeroOrgList,
  zeroOrgMembersList,
} from "../services/zero-org-data.service";

const adminRequired = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Access denied",
      code: "FORBIDDEN",
    }),
  }),
});

const getOrgInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(authContext$);
  if (!auth.orgId) {
    return notFound("Organization not found");
  }
  const org = await set(
    zeroOrgDetail$,
    { orgId: auth.orgId, userId: auth.userId },
    signal,
  );
  signal.throwIfAborted();
  if (!org) {
    return notFound("Organization not found");
  }
  return { status: 200 as const, body: org };
});

const listOrgsInner$ = computed(async (get) => {
  const auth = get(authContext$);
  const body = await get(zeroOrgList(auth.userId));
  return { status: 200 as const, body };
});

const listDomainsInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  if (auth.orgRole !== "admin") {
    return adminRequired;
  }
  const body = await get(zeroOrgDomainsList(auth.orgId));
  return { status: 200 as const, body };
});

const membersInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const body = await get(
    zeroOrgMembersList({
      orgId: auth.orgId,
      userId: auth.userId,
      // Fall back to "member" when the auth context lacks an explicit role
      // (rare: Zero tokens whose membership lookup did not return a role).
      callerRole: auth.orgRole ?? "member",
    }),
  );
  return { status: 200 as const, body };
});

export const zeroOrgReadRoutes: readonly RouteEntry[] = [
  {
    route: zeroOrgContract.get,
    handler: authRoute({ acceptAnySandboxCapability: true }, getOrgInner$),
  },
  {
    route: zeroOrgListContract.list,
    handler: authRoute({}, listOrgsInner$),
  },
  {
    route: zeroOrgDomainsContract.list,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      listDomainsInner$,
    ),
  },
  {
    route: zeroOrgMembersContract.members,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      membersInner$,
    ),
  },
];
