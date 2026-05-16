import { randomUUID } from "node:crypto";

import { cliTokens } from "@vm0/db/schema/cli-tokens";
import { creditExpiresRecord } from "@vm0/db/schema/credit-expires-record";
import { orgCache } from "@vm0/db/schema/org-cache";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { command, computed, type Computed } from "ccstate";
import { desc, eq, sql } from "drizzle-orm";

import { generateCliToken } from "../auth/tokens";
import { clerk$ } from "../external/clerk";
import { db$, writeDb$ } from "../external/db";
import { nowDate } from "../external/time";
import { settle } from "../utils";

export const DEFAULT_TEST_EMAIL = "dev+clerk_test+serial@vm0-e2e.ai";
export const CLI_TOKEN_EXPIRES_IN_SECONDS = 90 * 24 * 60 * 60;

const STARTER_GRANT_AMOUNT = 10_000;
const STARTER_GRANT_SOURCE = "starter_grant";
const FAR_FUTURE_CACHE_MS = 365 * 24 * 60 * 60 * 1000;
const ORG_CACHE_TTL_MS = 60_000;

interface IssuedCliToken {
  readonly token: string;
  readonly expiresIn: number;
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

export const orgIdBySlug$ = command(
  async (
    { get, set },
    slug: string,
    signal: AbortSignal,
  ): Promise<string | null> => {
    const [cached] = await get(db$)
      .select({ orgId: orgCache.orgId, cachedAt: orgCache.cachedAt })
      .from(orgCache)
      .where(eq(orgCache.slug, slug))
      .limit(1);
    signal.throwIfAborted();

    const currentTime = nowDate();
    if (
      cached &&
      currentTime.getTime() - cached.cachedAt.getTime() < ORG_CACHE_TTL_MS
    ) {
      return cached.orgId;
    }

    const client = get(clerk$);
    const result = await settle(client.organizations.getOrganization({ slug }));
    signal.throwIfAborted();

    if (!result.ok) {
      if (isClerkNotFound(result.error)) {
        return null;
      }
      throw result.error;
    }

    const org = result.value;
    if (!org.slug) {
      return null;
    }

    const writeDb = set(writeDb$);
    await writeDb
      .insert(orgCache)
      .values({
        orgId: org.id,
        slug: org.slug,
        name: org.name,
        createdBy: org.createdBy ?? null,
        cachedAt: currentTime,
      })
      .onConflictDoUpdate({
        target: orgCache.orgId,
        set: {
          slug: org.slug,
          name: org.name,
          createdBy: org.createdBy ?? null,
          cachedAt: currentTime,
        },
      });
    signal.throwIfAborted();

    return org.id;
  },
);

export const issueCliToken$ = command(
  async (
    { set },
    args: {
      readonly userId: string;
      readonly orgId: string;
      readonly name: string;
    },
    _signal: AbortSignal,
  ): Promise<IssuedCliToken> => {
    const writeDb = set(writeDb$);
    const tokenId = randomUUID();
    const now = nowDate();
    const expiresAt = new Date(
      now.getTime() + CLI_TOKEN_EXPIRES_IN_SECONDS * 1000,
    );
    const token = generateCliToken(args.userId, args.orgId, tokenId);

    await writeDb.insert(cliTokens).values({
      id: tokenId,
      token,
      userId: args.userId,
      name: args.name,
      expiresAt,
      createdAt: now,
    });

    return { token, expiresIn: CLI_TOKEN_EXPIRES_IN_SECONDS };
  },
);

export function testUserId(email: string): Computed<Promise<string>> {
  return computed(async (get): Promise<string> => {
    const { data: users } = await get(clerk$).users.getUserList({
      emailAddress: [email],
    });
    const userId = users[0]?.id;
    if (!userId) {
      throw new Error(`Test user not found for email: ${email}`);
    }
    return userId;
  });
}

function clerkRoleToCacheRole(role: string): "admin" | "member" {
  return role === "org:admin" ? "admin" : "member";
}

const ensureStarterCreditGrant$ = command(
  async ({ set }, orgId: string, _signal: AbortSignal): Promise<void> => {
    const writeDb = set(writeDb$);
    await writeDb.transaction(async (tx) => {
      const [existing] = await tx
        .select({ orgId: orgMetadata.orgId })
        .from(orgMetadata)
        .where(eq(orgMetadata.orgId, orgId))
        .limit(1);
      if (existing) {
        return;
      }

      const expiresAt = nowDate();
      expiresAt.setMonth(expiresAt.getMonth() + 1);
      const inserted = await tx
        .insert(creditExpiresRecord)
        .values({
          orgId,
          source: STARTER_GRANT_SOURCE,
          stripeInvoiceId: null,
          amount: STARTER_GRANT_AMOUNT,
          remaining: STARTER_GRANT_AMOUNT,
          expiresAt,
        })
        .onConflictDoNothing()
        .returning({ id: creditExpiresRecord.id });
      if (inserted.length === 0) {
        return;
      }

      await tx.execute(
        sql`INSERT INTO org_metadata (org_id, credits, created_at, updated_at)
            VALUES (${orgId}, ${STARTER_GRANT_AMOUNT}, now(), now())
            ON CONFLICT (org_id)
            DO UPDATE SET credits = org_metadata.credits + ${STARTER_GRANT_AMOUNT}, updated_at = now()`,
      );
    });
  },
);

export const ensureTestOrg$ = command(
  async (
    { get, set },
    userId: string,
    signal: AbortSignal,
  ): Promise<{ readonly orgId: string }> => {
    const memberships = await get(clerk$).users.getOrganizationMembershipList({
      userId,
    });
    signal.throwIfAborted();

    const ordered = [...memberships.data].sort((a, b) => {
      return a.createdAt - b.createdAt;
    });
    const membership = ordered[0];
    if (!membership) {
      throw new Error(`Test user ${userId} has no organization membership`);
    }

    const org = membership.organization;
    const writeDb = set(writeDb$);
    const [cached] = await writeDb
      .select({ orgId: orgCache.orgId })
      .from(orgCache)
      .where(eq(orgCache.orgId, org.id))
      .limit(1);
    signal.throwIfAborted();

    if (!cached) {
      await writeDb.insert(orgCache).values({
        orgId: org.id,
        slug: org.slug ?? org.id,
        name: org.name ?? org.slug ?? org.id,
        cachedAt: new Date(nowDate().getTime() + FAR_FUTURE_CACHE_MS),
      });
      signal.throwIfAborted();
    }

    await writeDb
      .insert(orgMembersCache)
      .values({
        orgId: org.id,
        userId,
        role: clerkRoleToCacheRole(membership.role),
        cachedAt: new Date(nowDate().getTime() + FAR_FUTURE_CACHE_MS),
      })
      .onConflictDoUpdate({
        target: [orgMembersCache.orgId, orgMembersCache.userId],
        set: {
          role: clerkRoleToCacheRole(membership.role),
          cachedAt: new Date(nowDate().getTime() + FAR_FUTURE_CACHE_MS),
        },
      });
    signal.throwIfAborted();

    await set(ensureStarterCreditGrant$, org.id, signal);
    signal.throwIfAborted();

    return { orgId: org.id };
  },
);

export function testUserOrgId(
  userId: string,
): Computed<Promise<string | null>> {
  return computed(async (get): Promise<string | null> => {
    const [cached] = await get(db$)
      .select({ orgId: orgMembersCache.orgId })
      .from(orgMembersCache)
      .where(eq(orgMembersCache.userId, userId))
      .orderBy(desc(orgMembersCache.cachedAt))
      .limit(1);
    return cached?.orgId ?? null;
  });
}
