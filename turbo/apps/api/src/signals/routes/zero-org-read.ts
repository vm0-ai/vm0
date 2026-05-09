import { computed } from "ccstate";
import { zeroOrgContract } from "@vm0/api-contracts/contracts/zero-org";
import { zeroOrgListContract } from "@vm0/api-contracts/contracts/zero-org-list";
import { zeroOrgDomainsContract } from "@vm0/api-contracts/contracts/zero-org-domains";
import { zeroOrgMembersContract } from "@vm0/api-contracts/contracts/zero-org-members";

import { authContext$, organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { shadowCompareRoute } from "../context/shadow-compare";
import { notFound } from "../../lib/error";
import type { RouteEntry } from "../route";
import {
  zeroOrgDetail,
  zeroOrgDomainsList,
  zeroOrgList,
  zeroOrgMembersList,
} from "../services/zero-org-data.service";

const getOrgInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const org = await get(zeroOrgDetail(auth.orgId, auth.userId));
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
  const body = await get(zeroOrgDomainsList(auth.orgId));
  return { status: 200 as const, body };
});

const membersInner$ = computed(async (get) => {
  const auth = get(organizationAuthContext$);
  const body = await get(zeroOrgMembersList(auth.orgId, "member"));
  return { status: 200 as const, body };
});

export const zeroOrgReadRoutes: readonly RouteEntry[] = [
  {
    route: zeroOrgContract.get,
    handler: shadowCompareRoute({
      route: zeroOrgContract.get,
      handler: authRoute(
        { requireOrganization: true, missingOrganizationStatus: 401 },
        getOrgInner$,
      ),
    }),
  },
  {
    route: zeroOrgListContract.list,
    handler: authRoute({}, listOrgsInner$),
  },
  {
    route: zeroOrgDomainsContract.list,
    handler: shadowCompareRoute({
      route: zeroOrgDomainsContract.list,
      handler: authRoute(
        { requireOrganization: true, missingOrganizationStatus: 401 },
        listDomainsInner$,
      ),
    }),
  },
  {
    route: zeroOrgMembersContract.members,
    handler: shadowCompareRoute({
      route: zeroOrgMembersContract.members,
      handler: authRoute(
        { requireOrganization: true, missingOrganizationStatus: 401 },
        membersInner$,
      ),
    }),
  },
];
