import { command, computed, type Computed } from "ccstate";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
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

import { db$, writeDb$ } from "../external/db";
import { clerk$ } from "../external/clerk";
import { fetchClerkMembershipRequests } from "../external/clerk-membership-requests";
import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { nowDate } from "../../lib/time";

const clerkOrgIdentitySchema = z.object({
  slug: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  createdBy: z.string().nullable().optional(),
});

const clerkDomainDataSchema = z.object({
  id: z.string(),
  name: z.string(),
  enrollment_mode: z.string().optional(),
  enrollmentMode: z.string().optional(),
  created_at: z.number().optional(),
  createdAt: z.number().optional(),
  verification: z
    .object({
      status: z.string(),
      strategy: z.string(),
    })
    .optional(),
});

interface OrgIdentity {
  readonly slug: string;
  readonly name: string;
  readonly createdBy: string | null;
}

const forbiddenAccess = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Access denied",
      code: "FORBIDDEN",
    }),
  }),
});

type OrgUpdateErrorResponse =
  | ReturnType<typeof badRequestMessage>
  | ReturnType<typeof conflict>
  | ReturnType<typeof notFound>
  | typeof forbiddenAccess;

interface UpdateZeroOrgArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly slug?: string;
  readonly name?: string;
  readonly force?: boolean;
}

interface ClerkUpdate {
  slug?: string;
  name?: string;
}

function isReservedSlug(slug: string): boolean {
  return (
    slug.startsWith("vm0") ||
    slug === "system" ||
    slug === "admin" ||
    slug === "api" ||
    slug === "app" ||
    slug === "www"
  );
}

function isClerkNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  return (
    Reflect.get(error, "statusCode") === 404 ||
    Reflect.get(error, "code") === "NOT_FOUND" ||
    Reflect.get(error, "name") === "NotFoundError"
  );
}

interface ZeroOrgDetailArgs {
  readonly orgId: string;
  readonly userId: string;
}

export const zeroOrgDetail$ = command(
  async (
    { get, set },
    args: ZeroOrgDetailArgs,
    signal: AbortSignal,
  ): Promise<OrgResponse | null> => {
    const db = get(db$);

    const [cached, meta, membership] = await Promise.all([
      db
        .select({
          slug: orgCache.slug,
          name: orgCache.name,
          createdBy: orgCache.createdBy,
        })
        .from(orgCache)
        .where(eq(orgCache.orgId, args.orgId))
        .limit(1),
      db
        .select({ tier: orgMetadata.tier })
        .from(orgMetadata)
        .where(eq(orgMetadata.orgId, args.orgId))
        .limit(1),
      db
        .select({ role: orgMembersCache.role })
        .from(orgMembersCache)
        .where(
          and(
            eq(orgMembersCache.orgId, args.orgId),
            eq(orgMembersCache.userId, args.userId),
          ),
        )
        .limit(1),
    ]);
    signal.throwIfAborted();

    let identity: OrgIdentity | undefined = cached[0];
    if (!identity) {
      const client = get(clerk$);
      const clerkOrg = await client.organizations
        .getOrganization({
          organizationId: args.orgId,
        })
        .catch((error: unknown) => {
          if (isClerkNotFound(error)) {
            return null;
          }
          throw error;
        });
      signal.throwIfAborted();

      if (!clerkOrg) {
        return null;
      }

      const parsed = clerkOrgIdentitySchema.parse(clerkOrg);
      if (!parsed.slug) {
        throw new Error(`Clerk organization ${args.orgId} has no slug`);
      }

      identity = {
        slug: parsed.slug,
        name: parsed.name ?? "",
        createdBy: parsed.createdBy ?? null,
      };

      const now = nowDate();
      const writeDb = set(writeDb$);
      await writeDb
        .insert(orgCache)
        .values({
          orgId: args.orgId,
          slug: identity.slug,
          name: identity.name,
          createdBy: identity.createdBy,
          cachedAt: now,
        })
        .onConflictDoUpdate({
          target: orgCache.orgId,
          set: {
            slug: identity.slug,
            name: identity.name,
            createdBy: identity.createdBy,
            cachedAt: now,
          },
        });
      signal.throwIfAborted();
    }

    return {
      id: args.orgId,
      slug: identity.slug,
      name: identity.name,
      tier: meta[0]?.tier ?? "free",
      role: (membership[0]?.role as OrgRole) ?? "member",
      createdBy: identity.createdBy ?? undefined,
    };
  },
);

export const updateZeroOrg$ = command(
  async (
    { get, set },
    args: UpdateZeroOrgArgs,
    signal: AbortSignal,
  ): Promise<OrgResponse | OrgUpdateErrorResponse> => {
    const db = get(db$);
    const [membership] = await db
      .select({ role: orgMembersCache.role })
      .from(orgMembersCache)
      .where(
        and(
          eq(orgMembersCache.orgId, args.orgId),
          eq(orgMembersCache.userId, args.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (!membership) {
      return forbiddenAccess;
    }

    const clerkUpdate: ClerkUpdate = {};

    if (args.slug) {
      if (!args.force) {
        return badRequestMessage(
          "Changing org slug may break existing references. Use --force to confirm.",
        );
      }

      if (isReservedSlug(args.slug)) {
        return badRequestMessage("Org slug is reserved");
      }

      const [existing] = await db
        .select({ orgId: orgCache.orgId })
        .from(orgCache)
        .where(eq(orgCache.slug, args.slug))
        .limit(1);
      signal.throwIfAborted();

      if (existing && existing.orgId !== args.orgId) {
        return conflict(`Org "${args.slug}" already exists`);
      }

      clerkUpdate.slug = args.slug;
    }

    if (args.name) {
      clerkUpdate.name = args.name;
    }

    if (clerkUpdate.slug || clerkUpdate.name) {
      const client = get(clerk$);
      await client.organizations.updateOrganization(args.orgId, clerkUpdate);
      signal.throwIfAborted();

      const writeDb = set(writeDb$);
      await writeDb.delete(orgCache).where(eq(orgCache.orgId, args.orgId));
      signal.throwIfAborted();
    }

    const org = await set(
      zeroOrgDetail$,
      { orgId: args.orgId, userId: args.userId },
      signal,
    );
    signal.throwIfAborted();

    if (!org) {
      return notFound(
        "No org configured. Set your org with: zero org set <slug>",
      );
    }

    return org;
  },
);

export function zeroOrgList(
  userId: string,
): Computed<Promise<OrgListResponse>> {
  return computed(async (get): Promise<OrgListResponse> => {
    const client = get(clerk$);
    const memberships = await client.users.getOrganizationMembershipList({
      userId,
    });
    return {
      orgs: memberships.data.map((membership) => {
        return {
          slug: membership.organization.slug,
          role: mapClerkOrgRole(membership.role),
        };
      }),
      active: undefined,
    };
  });
}

export function zeroOrgDomainsList(
  orgId: string,
): Computed<Promise<OrgDomainsResponse>> {
  return computed(async (get): Promise<OrgDomainsResponse> => {
    const client = get(clerk$);
    const domains = await client.organizations.getOrganizationDomainList({
      organizationId: orgId,
    });

    return {
      domains: domains.data.map((domain) => {
        const parsed = clerkDomainDataSchema.parse(domain);
        const enrollmentMode =
          parsed.enrollment_mode ?? parsed.enrollmentMode ?? "";
        const createdAtMs = parsed.created_at ?? parsed.createdAt;
        return {
          id: parsed.id,
          name: parsed.name,
          enrollmentMode,
          verification: parsed.verification
            ? {
                status: parsed.verification.status,
                strategy: parsed.verification.strategy,
              }
            : { status: "unverified", strategy: "email_code" },
          createdAt: createdAtMs
            ? new Date(createdAtMs).toISOString()
            : new Date(0).toISOString(),
        };
      }),
    };
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
