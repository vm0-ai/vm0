import { NextResponse } from "next/server";
import crypto from "crypto";
import { eq } from "drizzle-orm";
import { clerkClient } from "@clerk/nextjs/server";
import { initServices } from "../../../../../src/lib/init-services";
import { cliTokens } from "../../../../../src/db/schema/cli-tokens";
import { orgCache } from "../../../../../src/db/schema/org-cache";
import { orgMetadata } from "../../../../../src/db/schema/org-metadata";
import { orgMembersCache } from "../../../../../src/db/schema/org-members-cache";
import { getOrgData } from "../../../../../src/lib/org/org-cache-service";
import {
  resolveTestUserId,
  isTestVariant,
} from "../../../../../src/lib/auth/test-user";
import { env } from "../../../../../src/env";

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
 * If the user has no Clerk org yet, creates org_cache and org_members_cache
 * entries with a sentinel orgId.
 */
async function ensureTestOrg(userId: string): Promise<{ slug: string }> {
  // Query Clerk API directly for user's org memberships
  const client = await clerkClient();
  const memberships = await client.users.getOrganizationMembershipList({
    userId,
  });

  // Use a far-future cachedAt so org_cache TTL checks never expire these
  // entries and trigger a Clerk API refresh (sentinel orgs don't exist in Clerk).
  const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

  // Find first org with a matching org_cache entry
  for (const membership of memberships.data) {
    const orgId = membership.organization.id;
    try {
      const orgData = await getOrgData(orgId);
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
      return { slug: orgData.slug };
    } catch {
      // Org not in org_cache — try next membership
      continue;
    }
  }

  // User has no Clerk org — use sentinel orgId with org_cache + membership cache
  const sentinelOrgId = `org_test_${userId}`;
  const slug = "test-org";
  await globalThis.services.db
    .insert(orgCache)
    .values({
      orgId: sentinelOrgId,
      slug,
      cachedAt: farFuture,
    })
    .onConflictDoNothing();
  await globalThis.services.db
    .insert(orgMetadata)
    .values({ orgId: sentinelOrgId })
    .onConflictDoNothing();
  await globalThis.services.db
    .insert(orgMembersCache)
    .values({
      orgId: sentinelOrgId,
      userId,
      role: "admin",
      cachedAt: farFuture,
    })
    .onConflictDoNothing();
  return { slug };
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
  const variant = url.searchParams.get("variant") ?? "serial";
  if (!isTestVariant(variant)) {
    return NextResponse.json(
      { error: `Unknown test variant: ${variant}` },
      { status: 400 },
    );
  }
  const userId = await resolveTestUserId(variant);
  if (!userId) {
    return NextResponse.json({ error: "Test user not found" }, { status: 500 });
  }

  // Auto-create org if user doesn't have one (creates real Clerk org or sentinel)
  const { slug: orgSlug } = await ensureTestOrg(userId);

  // Generate CLI token
  const randomBytes = crypto.randomBytes(32);
  const token = `vm0_live_${randomBytes.toString("base64url")}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000); // 90 days

  await globalThis.services.db.insert(cliTokens).values({
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
    org_slug: orgSlug,
  });
}
