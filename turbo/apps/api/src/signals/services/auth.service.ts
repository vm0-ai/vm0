import { command, computed, type Computed } from "ccstate";
import { cliTokens } from "@okouai/db/schema/cli-tokens";
import { orgMembersCache } from "@okouai/db/schema/org-members-cache";
import { and, eq, gt, sql } from "drizzle-orm";

import {
  clerkRateLimit,
  membershipsByUserId,
  type OrganizationMembershipList,
} from "../external/clerk";
import { db$, writeDb$ } from "../external/db";
import { settle } from "../utils";
import type { Tx } from "../../lib/db-types";
import { now, nowDate } from "../../lib/time";
import type { ApiOrgRole, CliAuth, CliTokenRecord } from "../../types/auth";

const MEMBER_ROLE_CACHE_TTL_MS = 60_000;
const MEMBER_ROLE_CACHE_STALE_LIMIT_MS = 2 * MEMBER_ROLE_CACHE_TTL_MS;

interface MemberRoleCacheEntry {
  readonly role: string;
  readonly cachedAt: Date;
  readonly refreshAfter: Date | null;
}

type MemberRoleRefreshResult =
  | { readonly kind: "role"; readonly role: ApiOrgRole }
  | { readonly kind: "missing" }
  | { readonly kind: "rate-limited"; readonly retryAfterSeconds: number };

interface LockedMemberRoleRefreshArgs {
  readonly tx: Tx;
  readonly orgId: string;
  readonly userId: string;
  readonly loadMemberships: () => Promise<OrganizationMembershipList>;
}

interface RateLimitedMemberRoleArgs {
  readonly tx: Tx;
  readonly orgId: string;
  readonly userId: string;
  readonly cached: MemberRoleCacheEntry | undefined;
  readonly retryAfterSeconds: number;
}

export class MembershipRefreshRateLimitedError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("Clerk membership refresh is rate limited");
    this.name = "MembershipRefreshRateLimitedError";
  }
}

function mapClerkRole(role: string): ApiOrgRole {
  return role === "org:admin" ? "admin" : "member";
}

function mapCachedRole(role: string): ApiOrgRole {
  return role === "admin" ? "admin" : "member";
}

function cacheAge(entry: MemberRoleCacheEntry, currentTime: number): number {
  return currentTime - entry.cachedAt.getTime();
}

function activeRefreshDelay(
  entry: MemberRoleCacheEntry,
  currentTime: number,
): number | null {
  if (!entry.refreshAfter) {
    return null;
  }

  const remainingMs = entry.refreshAfter.getTime() - currentTime;
  return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : null;
}

function resolveCachedMemberRole(
  entry: MemberRoleCacheEntry | undefined,
  currentTime: number,
): MemberRoleRefreshResult | null {
  if (!entry) {
    return null;
  }

  const age = cacheAge(entry, currentTime);
  if (age < MEMBER_ROLE_CACHE_TTL_MS) {
    return { kind: "role", role: mapCachedRole(entry.role) };
  }

  const retryAfterSeconds = activeRefreshDelay(entry, currentTime);
  if (retryAfterSeconds === null) {
    return null;
  }

  if (age < MEMBER_ROLE_CACHE_STALE_LIMIT_MS) {
    return { kind: "role", role: mapCachedRole(entry.role) };
  }

  return { kind: "rate-limited", retryAfterSeconds };
}

async function recordMemberRoleRateLimit(
  args: RateLimitedMemberRoleArgs,
  signal: AbortSignal,
): Promise<MemberRoleRefreshResult> {
  const rateLimitedAt = now();
  if (args.cached) {
    await args.tx
      .update(orgMembersCache)
      .set({
        refreshAfter: new Date(rateLimitedAt + args.retryAfterSeconds * 1000),
      })
      .where(
        and(
          eq(orgMembersCache.orgId, args.orgId),
          eq(orgMembersCache.userId, args.userId),
        ),
      );
    signal.throwIfAborted();

    if (
      cacheAge(args.cached, rateLimitedAt) < MEMBER_ROLE_CACHE_STALE_LIMIT_MS
    ) {
      return { kind: "role", role: mapCachedRole(args.cached.role) };
    }
  }

  return {
    kind: "rate-limited",
    retryAfterSeconds: args.retryAfterSeconds,
  };
}

async function refreshLockedMemberRole(
  args: LockedMemberRoleRefreshArgs,
  signal: AbortSignal,
): Promise<MemberRoleRefreshResult> {
  const [cached] = await args.tx
    .select({
      role: orgMembersCache.role,
      cachedAt: orgMembersCache.cachedAt,
      refreshAfter: orgMembersCache.refreshAfter,
    })
    .from(orgMembersCache)
    .where(
      and(
        eq(orgMembersCache.orgId, args.orgId),
        eq(orgMembersCache.userId, args.userId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();

  const cachedResult = resolveCachedMemberRole(cached, now());
  if (cachedResult) {
    return cachedResult;
  }

  const membershipsResult = await settle(args.loadMemberships(), signal);
  if (!membershipsResult.ok) {
    const rateLimit = clerkRateLimit(membershipsResult.error);
    if (!rateLimit) {
      throw membershipsResult.error;
    }
    return await recordMemberRoleRateLimit(
      {
        tx: args.tx,
        orgId: args.orgId,
        userId: args.userId,
        cached,
        retryAfterSeconds: rateLimit.retryAfterSeconds,
      },
      signal,
    );
  }

  const membership = membershipsResult.value.data.find((candidate) => {
    return candidate.organization.id === args.orgId;
  });
  if (!membership) {
    if (cached) {
      await args.tx
        .delete(orgMembersCache)
        .where(
          and(
            eq(orgMembersCache.orgId, args.orgId),
            eq(orgMembersCache.userId, args.userId),
          ),
        );
      signal.throwIfAborted();
    }
    return { kind: "missing" };
  }

  const role = mapClerkRole(membership.role);
  const cachedAt = nowDate();
  await args.tx
    .insert(orgMembersCache)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      role,
      cachedAt,
      refreshAfter: null,
    })
    .onConflictDoUpdate({
      target: [orgMembersCache.orgId, orgMembersCache.userId],
      set: { role, cachedAt, refreshAfter: null },
    });
  signal.throwIfAborted();
  return { kind: "role", role };
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
        refreshAfter: orgMembersCache.refreshAfter,
      })
      .from(orgMembersCache)
      .where(
        and(
          eq(orgMembersCache.orgId, orgId),
          eq(orgMembersCache.userId, userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    const cachedResult = resolveCachedMemberRole(cached, now());
    if (cachedResult?.kind === "role") {
      return { role: cachedResult.role };
    }
    if (cachedResult?.kind === "rate-limited") {
      throw new MembershipRefreshRateLimitedError(
        cachedResult.retryAfterSeconds,
      );
    }

    const writeDb = set(writeDb$);
    const result = await writeDb.transaction(
      async (tx): Promise<MemberRoleRefreshResult> => {
        const lockKey = `clerk_membership:${orgId}:${userId}`;
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`,
        );
        signal.throwIfAborted();
        return await refreshLockedMemberRole(
          {
            tx,
            orgId,
            userId,
            loadMemberships: async (): Promise<OrganizationMembershipList> => {
              return await get(membershipsByUserId(userId));
            },
          },
          signal,
        );
      },
    );
    signal.throwIfAborted();

    if (result.kind === "rate-limited") {
      throw new MembershipRefreshRateLimitedError(result.retryAfterSeconds);
    }
    return result.kind === "role" ? { role: result.role } : null;
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
