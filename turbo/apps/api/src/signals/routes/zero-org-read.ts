import { command, computed } from "ccstate";
import {
  zeroOrgContract,
  zeroOrgLeaveContract,
} from "@vm0/api-contracts/contracts/zero-org";
import { zeroOrgListContract } from "@vm0/api-contracts/contracts/zero-org-list";
import { zeroOrgDomainsContract } from "@vm0/api-contracts/contracts/zero-org-domains";
import { zeroOrgMembersContract } from "@vm0/api-contracts/contracts/zero-org-members";

import { authContext$, organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf } from "../context/request";
import { clerk$ } from "../external/clerk";
import { badRequestMessage, notFound } from "../../lib/error";
import type { RouteEntry } from "../route";
import {
  leaveZeroOrg$,
  updateZeroOrg$,
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
    { orgId: auth.orgId, userId: auth.userId, orgRole: auth.orgRole },
    signal,
  );
  signal.throwIfAborted();
  if (!org) {
    return notFound("Organization not found");
  }
  return { status: 200 as const, body: org };
});

const updateOrgInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(authContext$);
  if (!auth.orgId) {
    return badRequestMessage(
      "No org configured. Set your org with: zero org set <slug>",
    );
  }

  const bodyResult = await get(bodyResultOf(zeroOrgContract.update));
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const result = await set(
    updateZeroOrg$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      slug: bodyResult.data.slug,
      name: bodyResult.data.name,
      force: bodyResult.data.force,
    },
    signal,
  );
  signal.throwIfAborted();

  if ("status" in result) {
    return result;
  }

  return {
    status: 200 as const,
    body: {
      id: result.id,
      slug: result.slug,
      name: result.name,
      tier: result.tier,
    },
  };
});

const leaveOrgBody$ = bodyResultOf(zeroOrgLeaveContract.leave);

const leaveOrgInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(leaveOrgBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const result = await set(
    leaveZeroOrg$,
    {
      orgId: auth.orgId,
      userId: auth.userId,
      role: auth.orgRole ?? "member",
    },
    signal,
  );
  signal.throwIfAborted();

  if ("status" in result) {
    return result;
  }

  return { status: 200 as const, body: result };
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

const addDomainBody$ = bodyResultOf(zeroOrgDomainsContract.add);

const addDomainInner$ = command(async ({ get }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (auth.orgRole !== "admin") {
    return adminRequired;
  }

  const bodyResult = await get(addDomainBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const client = get(clerk$);
  await client.organizations.createOrganizationDomain({
    organizationId: auth.orgId,
    name: bodyResult.data.name,
    enrollmentMode: bodyResult.data.enrollmentMode,
  });
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: { message: `Domain ${bodyResult.data.name} added` },
  };
});

const removeDomainBody$ = bodyResultOf(zeroOrgDomainsContract.remove);

const removeDomainInner$ = command(async ({ get }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (auth.orgRole !== "admin") {
    return adminRequired;
  }

  const bodyResult = await get(removeDomainBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const client = get(clerk$);
  await client.organizations.deleteOrganizationDomain({
    organizationId: auth.orgId,
    domainId: bodyResult.data.domainId,
  });
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: { message: "Domain removed" },
  };
});

const setVerifiedDomainBody$ = bodyResultOf(zeroOrgDomainsContract.setVerified);

const setVerifiedDomainInner$ = command(
  async ({ get }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.orgRole !== "admin") {
      return adminRequired;
    }

    const bodyResult = await get(setVerifiedDomainBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const client = get(clerk$);
    await client.organizations.updateOrganizationDomain({
      organizationId: auth.orgId,
      domainId: bodyResult.data.domainId,
      verified: bodyResult.data.verified,
    });
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        message: bodyResult.data.verified
          ? "Domain verified"
          : "Domain unverified",
      },
    };
  },
);

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
    route: zeroOrgContract.update,
    handler: authRoute({}, updateOrgInner$),
  },
  {
    route: zeroOrgLeaveContract.leave,
    handler: authRoute({ requireOrganization: true }, leaveOrgInner$),
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
    route: zeroOrgDomainsContract.add,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      addDomainInner$,
    ),
  },
  {
    route: zeroOrgDomainsContract.remove,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      removeDomainInner$,
    ),
  },
  {
    route: zeroOrgDomainsContract.setVerified,
    handler: authRoute(
      { requireOrganization: true, missingOrganizationStatus: 401 },
      setVerifiedDomainInner$,
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
