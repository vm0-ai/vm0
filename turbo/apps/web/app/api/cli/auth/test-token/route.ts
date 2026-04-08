import { NextResponse } from "next/server";
import crypto from "crypto";
import { eq } from "drizzle-orm";
import { clerkClient } from "@clerk/nextjs/server";
import { initServices } from "../../../../../src/lib/init-services";
import { cliTokens } from "../../../../../src/db/schema/cli-tokens";
import { orgCache } from "../../../../../src/db/schema/org-cache";
import { orgMembersCache } from "../../../../../src/db/schema/org-members-cache";
import { getOrgNameAndSlug } from "../../../../../src/lib/auth/org-cache";
import { generateCliToken } from "../../../../../src/lib/auth/sandbox-token";
import {
  resolveTestUserId,
  DEFAULT_TEST_EMAIL,
} from "../../../../../src/lib/auth/test-user";
import { env } from "../../../../../src/env";
import { logger } from "../../../../../src/lib/shared/logger";

const log = logger("api:test-token");

/**
 * Check if test-token endpoint is allowed based on environment.
 * Follows deny-by-default security principle.
 *
 * Access rules:
 * - Local development (no VERCEL_ENV, NODE_ENV=development): Allow
 * - Vercel preview (VERCEL_ENV=preview): Requires bypass secret header
 * - All other environments: Deny
 */
function isTestTokenAllowed(request: Request): boolean {
  const vercelEnv = env().VERCEL_ENV;
  const nodeEnv = env().NODE_ENV;

  if (!vercelEnv && nodeEnv === "development") {
    return true;
  }

  if (vercelEnv === "preview") {
    const bypassHeader = request.headers.get("x-vercel-protection-bypass");
    const expectedSecret = env().VERCEL_AUTOMATION_BYPASS_SECRET;
    return !!expectedSecret && bypassHeader === expectedSecret;
  }

  return false;
}

/**
 * Ensure the test user has an org_cache entry for org resolution.
 * Queries Clerk API directly to find the user's org membership,
 * then pre-populates org_members_cache for fast verification.
 *
 * Throws if the user has no Clerk org with a matching org_cache entry.
 */
async function ensureTestOrg(userId: string): Promise<{ orgId: string }> {
  // Query Clerk API directly for user's org memberships
  const client = await clerkClient();
  const memberships = await client.users.getOrganizationMembershipList({
    userId,
  });

  // Use a far-future cachedAt so org_cache TTL checks never expire these
  // entries during E2E test runs (avoids Clerk API calls + 429 rate limits).
  const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

  // Find first org: check org_cache first, populate from Clerk if missing
  for (const membership of memberships.data) {
    const orgId = membership.organization.id;
    const [cached] = await globalThis.services.db
      .select({ orgId: orgCache.orgId })
      .from(orgCache)
      .where(eq(orgCache.orgId, orgId))
      .limit(1);

    if (!cached) {
      // Org was just created in Clerk by CI but not yet in org_cache.
      // Populate the cache from Clerk so subsequent lookups are fast.
      log.info(
        `org ${orgId} not in org_cache, populating from Clerk for user ${userId}`,
      );
      await getOrgNameAndSlug(orgId);
    }

    const role = membership.role === "org:admin" ? "admin" : "member";
    // Pre-populate caches with far-future timestamps to prevent TTL expiry
    // during E2E test runs (avoids Clerk API calls + 429 rate limits)
    await globalThis.services.db
      .insert(orgMembersCache)
      .values({
        orgId,
        userId,
        role,
        cachedAt: farFuture,
      })
      .onConflictDoNothing();
    await globalThis.services.db
      .update(orgCache)
      .set({ cachedAt: farFuture })
      .where(eq(orgCache.orgId, orgId));
    return { orgId };
  }

  throw new Error(`Test user ${userId} has no organization in org_cache`);
}

/**
 * Test-only endpoint to directly generate a CLI token for the test user.
 * Only available in local development or Vercel preview with bypass secret.
 *
 * This endpoint bypasses the device flow entirely and directly creates a token,
 * allowing E2E tests to run without waiting for device flow authentication.
 */
export async function POST(request: Request) {
  if (!isTestTokenAllowed(request)) {
    return new NextResponse("Not found", { status: 404 });
  }

  initServices();

  const url = new URL(request.url);
  const email = url.searchParams.get("email") ?? DEFAULT_TEST_EMAIL;
  const userId = await resolveTestUserId(email);

  // Ensure user has an org in org_cache (provisioned by CI)
  const { orgId } = await ensureTestOrg(userId);

  // Generate CLI JWT with tokenId for revocation tracking
  const tokenId = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000); // 90 days
  const token = await generateCliToken(userId, orgId, tokenId);

  await globalThis.services.db.insert(cliTokens).values({
    id: tokenId,
    token,
    userId,
    name: "CI Test Token",
    expiresAt,
    createdAt: now,
  });

  return NextResponse.json({
    access_token: token,
    token_type: "Bearer",
    expires_in: 90 * 24 * 60 * 60,
    user_id: userId,
  });
}
