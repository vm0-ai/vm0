import { command, computed, type Computed } from "ccstate";
import { cliTokens } from "@vm0/db/schema/cli-tokens";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { and, eq, gt } from "drizzle-orm";

import { membershipsByUserId } from "../external/clerk";
import { db$, writeDb$ } from "../external/db";
import { now, nowDate } from "../external/time";
import {
  type ApiOrgRole,
  type CliAuth,
  type CliTokenRecord,
} from "../../types/auth";

const MEMBER_ROLE_CACHE_TTL_MS = 60_000;

function mapClerkRole(role: string): ApiOrgRole {
  return role === "org:admin" ? "admin" : "member";
}

export const updateCliTokenLastUsedAt$ = command(
  async ({ set }, tokenId: string, _signal: AbortSignal): Promise<void> => {
    const writeDb = set(writeDb$);
    await writeDb
      .update(cliTokens)
      .set({ lastUsedAt: nowDate() })
      .where(eq(cliTokens.id, tokenId));
  },
);

const upsertMemberRoleCache$ = command(
  async (
    { set },
    orgId: string,
    userId: string,
    role: ApiOrgRole,
    _signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    await writeDb
      .insert(orgMembersCache)
      .values({ orgId, userId, role, cachedAt: nowDate() })
      .onConflictDoUpdate({
        target: [orgMembersCache.orgId, orgMembersCache.userId],
        set: { role, cachedAt: nowDate() },
      });
  },
);

const deleteMemberRoleCache$ = command(
  async (
    { set },
    orgId: string,
    userId: string,
    _signal: AbortSignal,
  ): Promise<void> => {
    const writeDb = set(writeDb$);
    await writeDb
      .delete(orgMembersCache)
      .where(
        and(
          eq(orgMembersCache.orgId, orgId),
          eq(orgMembersCache.userId, userId),
        ),
      );
  },
);

export const getMemberRoleAndUpdateCache$ = command(
  async (
    { get, set },
    orgId: string,
    userId: string,
    signal: AbortSignal,
  ): Promise<{ role: ApiOrgRole } | null> => {
    const db = get(db$);
    const [cached] = await db
      .select({
        role: orgMembersCache.role,
        cachedAt: orgMembersCache.cachedAt,
      })
      .from(orgMembersCache)
      .where(
        and(
          eq(orgMembersCache.orgId, orgId),
          eq(orgMembersCache.userId, userId),
        ),
      )
      .limit(1);

    const currentTime = now();
    if (
      cached &&
      currentTime - cached.cachedAt.getTime() < MEMBER_ROLE_CACHE_TTL_MS
    ) {
      const role: ApiOrgRole = cached.role === "admin" ? "admin" : "member";
      return { role };
    }

    const memberships = await get(membershipsByUserId(userId));
    const membership = memberships.data.find((candidate) => {
      return candidate.organization.id === orgId;
    });

    if (!membership) {
      // Drop the stale row so the next call doesn't keep falling back to Clerk
      // for a user that's no longer a member.
      if (cached) {
        await set(deleteMemberRoleCache$, orgId, userId, signal);
      }
      return null;
    }

    const role = mapClerkRole(membership.role);
    await set(upsertMemberRoleCache$, orgId, userId, role, signal);
    return { role };
  },
);

export function cliTokenRecord(
  cliAuth: CliAuth,
): Computed<Promise<CliTokenRecord | null>> {
  return computed(async (get): Promise<CliTokenRecord | null> => {
    const db = get(db$);
    const currentDate = nowDate();
    const [record] = await db
      .select()
      .from(cliTokens)
      .where(
        and(
          eq(cliTokens.id, cliAuth.tokenId),
          gt(cliTokens.expiresAt, currentDate),
        ),
      )
      .limit(1);

    if (!record) {
      return null;
    }

    return {
      userId: cliAuth.userId,
      orgId: cliAuth.orgId,
    };
  });
}
