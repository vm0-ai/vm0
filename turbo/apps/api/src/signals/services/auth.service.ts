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

export function memberRole(
  orgId: string,
  userId: string,
): Computed<Promise<{ role: ApiOrgRole } | null>> {
  return computed(async (get): Promise<{ role: ApiOrgRole } | null> => {
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
    if (cached && currentTime - cached.cachedAt.getTime() < 60_000) {
      const role: ApiOrgRole = cached.role === "admin" ? "admin" : "member";
      return { role };
    }

    const memberships = await get(membershipsByUserId(userId));
    const membership = memberships.data.find((candidate) => {
      return candidate.organization.id === orgId;
    });

    if (!membership) {
      return null;
    }

    const role = mapClerkRole(membership.role);
    return { role };
  });
}

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
