import { computed, type Computed } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";
import { orgCache } from "@vm0/db/schema/org-cache";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import type { OrgResponse } from "@vm0/api-contracts/contracts/orgs";
import type { OrgListResponse } from "@vm0/api-contracts/contracts/org-list";
import type {
  OrgDomainsResponse,
  OrgMember,
  OrgMembersResponse,
  OrgRole,
} from "@vm0/api-contracts/contracts/org-members";
import type { User } from "@clerk/backend";

import { db$ } from "../external/db";
import { clerk$ } from "../external/clerk";
import { fetchClerkMembershipRequests } from "../external/clerk-membership-requests";

export function zeroOrgDetail(
  orgId: string,
  userId: string,
): Computed<Promise<OrgResponse | null>> {
  return computed(async (get): Promise<OrgResponse | null> => {
    const db = get(db$);

    const [cached, meta, membership] = await Promise.all([
      db
        .select({
          slug: orgCache.slug,
          name: orgCache.name,
          createdBy: orgCache.createdBy,
        })
        .from(orgCache)
        .where(eq(orgCache.orgId, orgId))
        .limit(1),
      db
        .select({ tier: orgMetadata.tier })
        .from(orgMetadata)
        .where(eq(orgMetadata.orgId, orgId))
        .limit(1),
      db
        .select({ role: orgMembersCache.role })
        .from(orgMembersCache)
        .where(
          and(
            eq(orgMembersCache.orgId, orgId),
            eq(orgMembersCache.userId, userId),
          ),
        )
        .limit(1),
    ]);

    if (!cached[0]) {
      return null;
    }

    return {
      id: orgId,
      slug: cached[0].slug,
      name: cached[0].name,
      tier: meta[0]?.tier ?? "free",
      role: (membership[0]?.role as OrgRole) ?? "member",
      createdBy: cached[0].createdBy ?? undefined,
    };
  });
}

export function zeroOrgList(
  userId: string,
): Computed<Promise<OrgListResponse>> {
  return computed(async (get): Promise<OrgListResponse> => {
    const db = get(db$);

    const memberships = await db
      .select({
        orgId: orgMembersCache.orgId,
        role: orgMembersCache.role,
      })
      .from(orgMembersCache)
      .where(eq(orgMembersCache.userId, userId));

    if (memberships.length === 0) {
      return { orgs: [] };
    }

    const orgIds = memberships.map((m) => {
      return m.orgId;
    });

    const caches = await db
      .select({ orgId: orgCache.orgId, slug: orgCache.slug })
      .from(orgCache)
      .where(inArray(orgCache.orgId, orgIds));

    const slugMap = new Map<string, string>();
    for (const c of caches) {
      slugMap.set(c.orgId, c.slug);
    }

    return {
      orgs: memberships.map((m) => {
        return {
          slug: slugMap.get(m.orgId) ?? m.orgId,
          role: m.role,
        };
      }),
    };
  });
}

export function zeroOrgDomainsList(
  _orgId: string,
): Computed<Promise<OrgDomainsResponse>> {
  return computed(async (): Promise<OrgDomainsResponse> => {
    // Domains are sourced from Clerk. The API app does not have an
    // org_domains table — return an empty list so the contract is satisfied.
    // Callers that need real domain data should go through the web-side Clerk
    // integration or the Clerk REST API.
    await Promise.resolve();
    return { domains: [] };
  });
}

interface OrgMembersListArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly callerRole: OrgRole;
}

interface ClerkUserProfile {
  readonly email: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly imageUrl: string;
}

function mapClerkOrgRole(clerkRole: string): OrgRole {
  return clerkRole === "org:admin" ? "admin" : "member";
}

function userPrimaryEmail(user: User): string {
  const primary = user.emailAddresses.find((e) => {
    return e.id === user.primaryEmailAddressId;
  });
  return primary?.emailAddress ?? "";
}

async function fetchUserProfileMap(
  client: ReturnType<typeof clerk$.read>,
  userIds: readonly string[],
): Promise<Map<string, ClerkUserProfile>> {
  const map = new Map<string, ClerkUserProfile>();
  if (userIds.length === 0) {
    return map;
  }
  const users = await client.users.getUserList({ userId: [...userIds] });
  for (const user of users.data) {
    map.set(user.id, {
      email: userPrimaryEmail(user),
      firstName: user.firstName,
      lastName: user.lastName,
      imageUrl: user.imageUrl,
    });
  }
  return map;
}

export function zeroOrgMembersList(
  args: OrgMembersListArgs,
): Computed<Promise<OrgMembersResponse>> {
  return computed(async (get): Promise<OrgMembersResponse> => {
    const client = get(clerk$);

    const [org, memberships, invitations] = await Promise.all([
      client.organizations.getOrganization({ organizationId: args.orgId }),
      client.organizations.getOrganizationMembershipList({
        organizationId: args.orgId,
      }),
      client.organizations.getOrganizationInvitationList({
        organizationId: args.orgId,
        status: ["pending"],
      }),
    ]);

    const memberUserIds = memberships.data
      .map((m) => {
        return m.publicUserData?.userId;
      })
      .filter((id): id is string => {
        return Boolean(id);
      });
    const memberProfiles = await fetchUserProfileMap(client, memberUserIds);

    const memberList: OrgMember[] = memberships.data.map((membership) => {
      const uid = membership.publicUserData?.userId ?? "";
      const profile = memberProfiles.get(uid);
      return {
        userId: uid,
        email: profile?.email ?? "",
        firstName: profile?.firstName ?? null,
        lastName: profile?.lastName ?? null,
        imageUrl: profile?.imageUrl ?? "",
        role: mapClerkOrgRole(membership.role),
        joinedAt: membership.createdAt
          ? new Date(membership.createdAt).toISOString()
          : "",
      };
    });

    const pendingInvitations =
      args.callerRole === "admin"
        ? invitations.data.map((inv) => {
            return {
              id: inv.id,
              email: inv.emailAddress,
              role: mapClerkOrgRole(inv.role),
              createdAt: new Date(inv.createdAt).toISOString(),
            };
          })
        : [];

    let membershipRequests: NonNullable<
      OrgMembersResponse["membershipRequests"]
    > = [];
    if (args.callerRole === "admin") {
      const requestsData = await fetchClerkMembershipRequests(args.orgId);
      const requestUserIds = requestsData
        .map((r) => {
          return r.public_user_data?.user_id;
        })
        .filter((id): id is string => {
          return Boolean(id);
        });
      const requestProfiles = await fetchUserProfileMap(client, requestUserIds);
      membershipRequests = requestsData.map((req) => {
        const uid = req.public_user_data?.user_id ?? "";
        const profile = requestProfiles.get(uid);
        return {
          id: req.id,
          userId: uid,
          email: profile?.email ?? "",
          firstName: profile?.firstName ?? null,
          lastName: profile?.lastName ?? null,
          imageUrl: profile?.imageUrl ?? "",
          createdAt: new Date(req.created_at).toISOString(),
        };
      });
    }

    return {
      slug: org.slug ?? args.orgId,
      role: args.callerRole,
      members: memberList,
      pendingInvitations,
      membershipRequests,
      createdAt: new Date(org.createdAt).toISOString(),
    };
  });
}
