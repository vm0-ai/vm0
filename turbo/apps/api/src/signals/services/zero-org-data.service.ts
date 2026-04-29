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

import { db$ } from "../external/db";

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

export function zeroOrgMembersList(
  orgId: string,
  callerRole: OrgRole,
): Computed<Promise<OrgMembersResponse>> {
  return computed(async (get): Promise<OrgMembersResponse> => {
    const db = get(db$);

    const [members, orgRow] = await Promise.all([
      db
        .select({
          userId: orgMembersCache.userId,
          role: orgMembersCache.role,
        })
        .from(orgMembersCache)
        .where(eq(orgMembersCache.orgId, orgId)),
      db
        .select({
          slug: orgCache.slug,
          cachedAt: orgCache.cachedAt,
        })
        .from(orgCache)
        .where(eq(orgCache.orgId, orgId))
        .limit(1),
    ]);

    const createdAt = orgRow[0]?.cachedAt?.toISOString() ?? "";

    const memberList: OrgMember[] = members.map((m) => {
      return {
        userId: m.userId,
        email: "",
        firstName: null,
        lastName: null,
        imageUrl: "",
        role: m.role as OrgRole,
        joinedAt: "",
      };
    });

    return {
      slug: orgRow[0]?.slug ?? orgId,
      role: callerRole,
      members: memberList,
      createdAt,
    };
  });
}
