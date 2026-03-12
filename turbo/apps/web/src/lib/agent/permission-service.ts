import { eq, and, or, ne, desc } from "drizzle-orm";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { agentComposes } from "../../db/schema/agent-compose";
import { agentPermissions } from "../../db/schema/agent-permission";
import { orgMembersCache } from "../../db/schema/org-members-cache";
import { logger } from "../logger";
import { getOrgData } from "../scope/org-cache-service";

const log = logger("agent:permission");

/** Cache TTL aligned with Clerk JWT TTL */
const CACHE_TTL_MS = 60_000; // 1 minute

/**
 * Check if a user can access an agent compose
 *
 * Access is granted if:
 * 1. User is the owner of the compose
 * 2. User is a member of the same Clerk organization
 * 3. Compose has a 'public' permission entry
 * 4. User's email matches an 'email' permission entry
 */
export async function canAccessCompose(
  userId: string,
  userEmail: string,
  compose: { id: string; userId: string; orgId: string },
): Promise<boolean> {
  // 1. Owner always has access
  if (compose.userId === userId) return true;

  // 2. Check org membership via Clerk
  const authResult = await auth();

  // JWT fast path: active org matches → trust JWT, no API call
  if (authResult.orgId === compose.orgId) {
    return true;
  }

  // Cache-backed Clerk API fallback for cross-org or non-session contexts
  if (!compose.orgId.startsWith("pending_")) {
    // Check org_members_cache first (DB read, no Clerk API call)
    const [cached] = await globalThis.services.db
      .select({ cachedAt: orgMembersCache.cachedAt })
      .from(orgMembersCache)
      .where(
        and(
          eq(orgMembersCache.orgId, compose.orgId),
          eq(orgMembersCache.userId, userId),
        ),
      )
      .limit(1);

    if (cached && Date.now() - cached.cachedAt.getTime() < CACHE_TTL_MS) {
      return true;
    }

    // Cache miss or stale — call Clerk API and update cache
    const client = await clerkClient();
    const memberships = await client.users.getOrganizationMembershipList({
      userId,
      limit: 100,
    });
    const isMember = memberships.data.some(
      (m) => m.organization.id === compose.orgId,
    );
    if (isMember) {
      // Fire-and-forget: cache write is non-critical, don't block access
      const now = new Date();
      void globalThis.services.db
        .insert(orgMembersCache)
        .values({
          orgId: compose.orgId,
          userId,
          cachedAt: now,
        })
        .onConflictDoUpdate({
          target: [orgMembersCache.orgId, orgMembersCache.userId],
          set: { cachedAt: now },
        })
        .catch((err: unknown) => {
          log.warn("Failed to update org_members_cache", { err });
        });
      return true;
    }
  }

  // 3. Check ACL
  const permissionResult = await globalThis.services.db
    .select()
    .from(agentPermissions)
    .where(
      and(
        eq(agentPermissions.agentComposeId, compose.id),
        or(
          eq(agentPermissions.granteeType, "public"),
          and(
            eq(agentPermissions.granteeType, "email"),
            eq(agentPermissions.granteeEmail, userEmail),
          ),
        ),
      ),
    )
    .limit(1);

  return !!permissionResult[0];
}

/**
 * Add a permission to an agent compose
 */
export async function addPermission(
  composeId: string,
  granteeType: "public" | "email",
  grantedBy: string,
  granteeEmail?: string,
): Promise<void> {
  await globalThis.services.db.insert(agentPermissions).values({
    agentComposeId: composeId,
    granteeType,
    granteeEmail: granteeType === "email" ? granteeEmail : null,
    grantedBy,
  });
  log.info(
    `Permission added: ${granteeType} ${granteeEmail ?? ""} -> ${composeId}`,
  );
}

/**
 * Remove a permission from an agent compose
 */
export async function removePermission(
  composeId: string,
  granteeType: "public" | "email",
  granteeEmail?: string,
): Promise<boolean> {
  const conditions = [
    eq(agentPermissions.agentComposeId, composeId),
    eq(agentPermissions.granteeType, granteeType),
  ];

  if (granteeType === "email" && granteeEmail) {
    conditions.push(eq(agentPermissions.granteeEmail, granteeEmail));
  }

  const result = await globalThis.services.db
    .delete(agentPermissions)
    .where(and(...conditions));

  return (result.rowCount ?? 0) > 0;
}

interface SharedAgent {
  id: string;
  name: string;
  headVersionId: string | null;
  createdAt: Date;
  updatedAt: Date;
  orgSlug: string;
}

/**
 * Fetch agents shared with a user via email permissions.
 * Excludes agents the user owns (to avoid duplicates).
 */
export async function getEmailSharedAgents(
  userId: string,
  userEmail: string,
  options?: { nameFilter?: string },
): Promise<SharedAgent[]> {
  const conditions = [
    eq(agentPermissions.granteeType, "email"),
    eq(agentPermissions.granteeEmail, userEmail),
    ne(agentComposes.userId, userId),
  ];

  if (options?.nameFilter) {
    conditions.push(eq(agentComposes.name, options.nameFilter));
  }

  const rows = await globalThis.services.db
    .select({
      id: agentComposes.id,
      name: agentComposes.name,
      headVersionId: agentComposes.headVersionId,
      createdAt: agentComposes.createdAt,
      updatedAt: agentComposes.updatedAt,
      orgId: agentComposes.orgId,
    })
    .from(agentPermissions)
    .innerJoin(
      agentComposes,
      eq(agentPermissions.agentComposeId, agentComposes.id),
    )
    .where(and(...conditions))
    .orderBy(desc(agentComposes.createdAt));

  // Resolve scope slugs via org cache (skip orgs that fail lookup)
  const uniqueOrgIds = [...new Set(rows.map((r) => r.orgId))];
  const orgDataResults = await Promise.all(
    uniqueOrgIds.map(async (id) => {
      try {
        return [id, await getOrgData(id)] as const;
      } catch (err) {
        log.warn("failed to resolve org data for shared agent", {
          orgId: id,
          error: err,
        });
        return [id, null] as const;
      }
    }),
  );
  const orgDataMap = new Map(orgDataResults.filter(([, v]) => v !== null));

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    headVersionId: row.headVersionId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    orgSlug: orgDataMap.get(row.orgId)?.slug ?? "",
  }));
}

/**
 * List all permissions for an agent compose
 */
export async function listPermissions(composeId: string) {
  return globalThis.services.db
    .select()
    .from(agentPermissions)
    .where(eq(agentPermissions.agentComposeId, composeId))
    .orderBy(agentPermissions.createdAt);
}
