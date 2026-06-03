import { command, computed, type Computed } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { orgCache } from "@vm0/db/schema/org-cache";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import type { OrgResponse } from "@vm0/api-contracts/contracts/orgs";
import type { OrgListResponse } from "@vm0/api-contracts/contracts/org-list";
import type {
  OrgMessageResponse,
  OrgMember,
  OrgMembersResponse,
  OrgRole,
} from "@vm0/api-contracts/contracts/org-members";
import type { User } from "@clerk/backend";

import { db$, writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { clerk$ } from "../external/clerk";
import { fetchClerkMembershipRequests } from "../external/clerk-membership-requests";
import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { nowDate } from "../../lib/time";
import { settle } from "../utils";

const clerkOrgIdentitySchema = z.object({
  slug: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  createdBy: z.string().nullable().optional(),
});

interface OrgIdentity {
  readonly slug: string;
  readonly name: string;
  readonly createdBy: string | null;
}

const CACHE_TTL_MS = 60_000;

const forbiddenAccess = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Access denied",
      code: "FORBIDDEN",
    }),
  }),
});

const adminCannotLeave = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Admins cannot leave the organization",
      code: "FORBIDDEN",
    }),
  }),
});

const orgDeleteForbidden = Object.freeze({
  status: 403 as const,
  body: Object.freeze({
    error: Object.freeze({
      message: "Only admins can delete the organization",
      code: "FORBIDDEN",
    }),
  }),
});

type OrgUpdateErrorResponse =
  | ReturnType<typeof badRequestMessage>
  | ReturnType<typeof conflict>
  | ReturnType<typeof notFound>
  | typeof forbiddenAccess;

type OrgDeleteErrorResponse =
  | ReturnType<typeof badRequestMessage>
  | ReturnType<typeof notFound>
  | typeof orgDeleteForbidden;

type RemoveZeroOrgMemberErrorResponse =
  | ReturnType<typeof badRequestMessage>
  | ReturnType<typeof notFound>
  | typeof forbiddenAccess;

type UpdateZeroOrgMemberRoleErrorResponse =
  | ReturnType<typeof badRequestMessage>
  | ReturnType<typeof notFound>
  | typeof forbiddenAccess;

interface UpdateZeroOrgArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly slug?: string;
  readonly name?: string;
  readonly force?: boolean;
}

interface LeaveZeroOrgArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly role: OrgRole;
}

interface DeleteZeroOrgArgs {
  readonly orgId: string;
  readonly callerRole: OrgRole | undefined;
  readonly slug: string;
}

interface RemoveZeroOrgMemberArgs {
  readonly orgId: string;
  readonly callerUserId: string;
  readonly callerRole: OrgRole;
  readonly email: string;
}

interface UpdateZeroOrgMemberRoleArgs {
  readonly callerUserId: string;
  readonly orgId: string;
  readonly callerRole: OrgRole | undefined;
  readonly targetEmail: string;
  readonly newRole: OrgRole;
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

async function cleanupOrgMember(
  writeDb: Db,
  args: Pick<LeaveZeroOrgArgs, "orgId" | "userId">,
  signal: AbortSignal,
): Promise<void> {
  const [installation] = await writeDb
    .select({ slackWorkspaceId: slackOrgInstallations.slackWorkspaceId })
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.orgId, args.orgId))
    .limit(1);
  signal.throwIfAborted();

  if (installation) {
    const connections = await writeDb
      .select({ id: slackOrgConnections.id })
      .from(slackOrgConnections)
      .where(
        and(
          eq(slackOrgConnections.vm0UserId, args.userId),
          eq(
            slackOrgConnections.slackWorkspaceId,
            installation.slackWorkspaceId,
          ),
        ),
      );
    signal.throwIfAborted();

    if (connections.length > 0) {
      await writeDb.delete(slackOrgConnections).where(
        inArray(
          slackOrgConnections.id,
          connections.map((connection) => {
            return connection.id;
          }),
        ),
      );
      signal.throwIfAborted();
    }
  }

  await writeDb
    .delete(orgMembersCache)
    .where(
      and(
        eq(orgMembersCache.userId, args.userId),
        eq(orgMembersCache.orgId, args.orgId),
      ),
    );
  signal.throwIfAborted();

  await writeDb
    .delete(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.userId, args.userId),
        eq(orgMembersMetadata.orgId, args.orgId),
      ),
    );
  signal.throwIfAborted();
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

async function getOrgIdentityForDelete(args: {
  readonly db: ReadonlyDb;
  readonly writeDb: Db;
  readonly client: ReturnType<typeof clerk$.read>;
  readonly orgId: string;
}): Promise<OrgIdentity | null> {
  const [cached] = await args.db
    .select({
      slug: orgCache.slug,
      name: orgCache.name,
      createdBy: orgCache.createdBy,
      cachedAt: orgCache.cachedAt,
    })
    .from(orgCache)
    .where(eq(orgCache.orgId, args.orgId))
    .limit(1);

  const now = nowDate();
  if (cached && now.getTime() - cached.cachedAt.getTime() < CACHE_TTL_MS) {
    return {
      slug: cached.slug,
      name: cached.name,
      createdBy: cached.createdBy,
    };
  }

  const clerkOrgSettled = await settle(
    args.client.organizations.getOrganization({ organizationId: args.orgId }),
  );
  if (!clerkOrgSettled.ok) {
    if (isClerkNotFound(clerkOrgSettled.error)) {
      return null;
    }
    throw clerkOrgSettled.error;
  }
  const clerkOrg = clerkOrgSettled.value;

  const parsed = clerkOrgIdentitySchema.parse(clerkOrg);
  if (!parsed.slug) {
    throw new Error(`Clerk organization ${args.orgId} has no slug`);
  }

  await args.writeDb
    .insert(orgCache)
    .values({
      orgId: args.orgId,
      slug: parsed.slug,
      name: parsed.name ?? "",
      createdBy: parsed.createdBy ?? null,
      cachedAt: now,
    })
    .onConflictDoUpdate({
      target: orgCache.orgId,
      set: {
        slug: parsed.slug,
        name: parsed.name ?? "",
        createdBy: parsed.createdBy ?? null,
        cachedAt: now,
      },
    });

  return {
    slug: parsed.slug,
    name: parsed.name ?? "",
    createdBy: parsed.createdBy ?? null,
  };
}

interface ZeroOrgDetailArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly orgRole?: OrgRole;
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
      const clerkOrgSettled = await settle(
        client.organizations.getOrganization({
          organizationId: args.orgId,
        }),
      );
      signal.throwIfAborted();

      if (!clerkOrgSettled.ok) {
        if (isClerkNotFound(clerkOrgSettled.error)) {
          return null;
        }
        throw clerkOrgSettled.error;
      }
      const clerkOrg = clerkOrgSettled.value;

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
      tier: meta[0]?.tier ?? "pro-suspend",
      role: args.orgRole ?? (membership[0]?.role as OrgRole) ?? "member",
      createdBy: identity.createdBy ?? undefined,
    };
  },
);

export const leaveZeroOrg$ = command(
  async (
    { get, set },
    args: LeaveZeroOrgArgs,
    signal: AbortSignal,
  ): Promise<OrgMessageResponse | typeof adminCannotLeave> => {
    if (args.role === "admin") {
      return adminCannotLeave;
    }

    const client = get(clerk$);
    await client.organizations.deleteOrganizationMembership({
      organizationId: args.orgId,
      userId: args.userId,
    });
    signal.throwIfAborted();

    await cleanupOrgMember(set(writeDb$), args, signal);
    signal.throwIfAborted();

    return { message: "Left org" };
  },
);

export const removeZeroOrgMember$ = command(
  async (
    { get, set },
    args: RemoveZeroOrgMemberArgs,
    signal: AbortSignal,
  ): Promise<OrgMessageResponse | RemoveZeroOrgMemberErrorResponse> => {
    if (args.callerRole !== "admin") {
      return forbiddenAccess;
    }

    const client = get(clerk$);
    const users = await client.users.getUserList({
      emailAddress: [args.email],
    });
    signal.throwIfAborted();

    const target = users.data[0];
    if (!target) {
      return notFound("Resource not found");
    }

    if (target.id === args.callerUserId) {
      return badRequestMessage("Invalid request");
    }

    const memberships =
      await client.organizations.getOrganizationMembershipList({
        organizationId: args.orgId,
      });
    signal.throwIfAborted();

    const membership = memberships.data.find((entry) => {
      return entry.publicUserData?.userId === target.id;
    });
    if (!membership) {
      return notFound("Resource not found");
    }

    await client.organizations.deleteOrganizationMembership({
      organizationId: args.orgId,
      userId: target.id,
    });
    signal.throwIfAborted();

    await cleanupOrgMember(
      set(writeDb$),
      { orgId: args.orgId, userId: target.id },
      signal,
    );
    signal.throwIfAborted();

    return { message: `Removed ${args.email} from org` };
  },
);

export const updateZeroOrgMemberRole$ = command(
  async (
    { get },
    args: UpdateZeroOrgMemberRoleArgs,
    signal: AbortSignal,
  ): Promise<OrgMessageResponse | UpdateZeroOrgMemberRoleErrorResponse> => {
    if (args.callerRole !== "admin") {
      return forbiddenAccess;
    }

    const client = get(clerk$);
    const users = await client.users.getUserList({
      emailAddress: [args.targetEmail],
    });
    signal.throwIfAborted();

    const targetUser = users.data[0];
    if (!targetUser) {
      return notFound("Resource not found");
    }

    if (targetUser.id === args.callerUserId) {
      if (args.newRole !== "member") {
        return badRequestMessage("Invalid request");
      }

      const memberships =
        await client.organizations.getOrganizationMembershipList({
          organizationId: args.orgId,
        });
      signal.throwIfAborted();

      const adminCount = memberships.data.filter((membership) => {
        return membership.role === "org:admin";
      }).length;
      if (adminCount < 2) {
        return badRequestMessage("Invalid request");
      }
    }

    await client.organizations.updateOrganizationMembership({
      organizationId: args.orgId,
      userId: targetUser.id,
      role: args.newRole === "admin" ? "org:admin" : "org:member",
    });
    signal.throwIfAborted();

    return { message: `Updated role for ${args.targetEmail}` };
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

export const deleteZeroOrg$ = command(
  async (
    { get, set },
    args: DeleteZeroOrgArgs,
    signal: AbortSignal,
  ): Promise<{ readonly message: string } | OrgDeleteErrorResponse> => {
    if (args.callerRole !== "admin") {
      return orgDeleteForbidden;
    }

    const db = get(db$);
    const writeDb = set(writeDb$);
    const client = get(clerk$);
    const identity = await getOrgIdentityForDelete({
      db,
      writeDb,
      client,
      orgId: args.orgId,
    });
    signal.throwIfAborted();

    if (!identity) {
      return notFound("Resource not found");
    }

    if (args.slug !== identity.slug) {
      return badRequestMessage("Organization name does not match");
    }

    const memberships =
      await client.organizations.getOrganizationMembershipList({
        organizationId: args.orgId,
      });
    signal.throwIfAborted();

    const memberUserIds = memberships.data
      .map((membership) => {
        return membership.publicUserData?.userId;
      })
      .filter((userId): userId is string => {
        return Boolean(userId);
      });

    for (const userId of memberUserIds) {
      const [installation] = await db
        .select({
          slackWorkspaceId: slackOrgInstallations.slackWorkspaceId,
        })
        .from(slackOrgInstallations)
        .where(eq(slackOrgInstallations.orgId, args.orgId))
        .limit(1);
      signal.throwIfAborted();

      if (installation) {
        await writeDb
          .delete(slackOrgConnections)
          .where(
            and(
              eq(slackOrgConnections.vm0UserId, userId),
              eq(
                slackOrgConnections.slackWorkspaceId,
                installation.slackWorkspaceId,
              ),
            ),
          );
        signal.throwIfAborted();
      }

      await writeDb
        .delete(orgMembersCache)
        .where(
          and(
            eq(orgMembersCache.userId, userId),
            eq(orgMembersCache.orgId, args.orgId),
          ),
        );
      signal.throwIfAborted();

      await writeDb
        .delete(orgMembersMetadata)
        .where(
          and(
            eq(orgMembersMetadata.userId, userId),
            eq(orgMembersMetadata.orgId, args.orgId),
          ),
        );
      signal.throwIfAborted();
    }

    await client.organizations.deleteOrganization(args.orgId);
    signal.throwIfAborted();

    return { message: "Organization deleted" };
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
