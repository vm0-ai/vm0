import { NextResponse } from "next/server";
import crypto from "crypto";
import { eq } from "drizzle-orm";
import { clerkClient } from "@clerk/nextjs/server";
import { initServices } from "../../../../../src/lib/init-services";
import { cliTokens } from "../../../../../src/db/schema/cli-tokens";
import { orgCache } from "../../../../../src/db/schema/org-cache";
import { orgMetadata } from "../../../../../src/db/schema/org-metadata";
import { orgMembersCache } from "../../../../../src/db/schema/org-members-cache";
import {
  getOrgData,
  getOrgBySlug,
} from "../../../../../src/lib/org/org-cache-service";
import { generateCliToken } from "../../../../../src/lib/auth/sandbox-token";
import {
  resolveTestUserId,
  DEFAULT_TEST_EMAIL,
  orgSlugFromEmail,
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
 * Ensure the test user has a real Clerk org and corresponding org_cache entry.
 * Queries Clerk API to find the user's org membership. If found in org_cache,
 * refreshes the cache TTL. If not in Clerk, creates a real Clerk org.
 *
 * Always creates a real Clerk org (never a sentinel) so all Clerk-aware
 * operations (e.g. zero org set, model-provider setup) work correctly.
 */
async function ensureTestOrg(
  userId: string,
  email: string,
): Promise<{ slug: string }> {
  // Query Clerk API directly for user's org memberships
  const client = await clerkClient();
  type MembershipItem = Awaited<
    ReturnType<typeof client.users.getOrganizationMembershipList>
  >["data"][number];
  let membershipItems: MembershipItem[] = [];
  try {
    const result = await client.users.getOrganizationMembershipList({ userId });
    membershipItems = result.data;
  } catch {
    // userId not found in Clerk — fall through to sentinel org
  }

  // Use a far-future cachedAt so org_cache TTL checks never expire during tests
  const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

  // Find first org with a matching org_cache entry
  for (const membership of membershipItems) {
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

  // User has no Clerk org — create a real one so Clerk-aware operations work
  const slug = orgSlugFromEmail(email);
  const org = await client.organizations.createOrganization({
    name: slug,
    slug,
    createdBy: userId,
  });
  const orgId = org.id;

  // Populate caches for the newly created org
  await globalThis.services.db
    .insert(orgCache)
    .values({
      orgId,
      slug,
      cachedAt: farFuture,
    })
    .onConflictDoUpdate({
      target: orgCache.orgId,
      set: { slug, cachedAt: farFuture },
    });
  await globalThis.services.db
    .insert(orgMetadata)
    .values({ orgId })
    .onConflictDoNothing();
  await globalThis.services.db
    .insert(orgMembersCache)
    .values({
      orgId,
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
  const email = url.searchParams.get("email") ?? DEFAULT_TEST_EMAIL;
  const userId = await resolveTestUserId(email);

  // Auto-create org if user doesn't have one
  const { slug: orgSlug } = await ensureTestOrg(userId, email);

  // Resolve orgId from slug (ensureTestOrg creates org_cache entry, so this is a cache hit)
  const orgData = await getOrgBySlug(orgSlug);
  if (!orgData) {
    return NextResponse.json(
      { error: `Organization not found for slug: ${orgSlug}` },
      { status: 500 },
    );
  }
  const orgId = orgData.orgId;

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
    org_slug: orgSlug,
  });
}
