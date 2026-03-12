import { NextResponse } from "next/server";
import crypto from "crypto";
import { initServices } from "../../../../../src/lib/init-services";
import { cliTokens } from "../../../../../src/db/schema/cli-tokens";
import { generateDefaultScopeSlug } from "../../../../../src/lib/scope/scope-service";
import { getDefaultScope } from "../../../../../src/lib/scope/scope-member-service";
import { orgCache } from "../../../../../src/db/schema/org-cache";
import { isNotFound } from "../../../../../src/lib/errors";
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
 * Ensure the test user has an org_cache entry for scope resolution.
 * Uses the same flow as production (getDefaultScope) so that
 * Clerk API membership verification works during E2E tests.
 *
 * If the user has no Clerk org yet, creates an org_cache entry with a sentinel orgId.
 */
async function ensureTestScope(userId: string): Promise<{ orgId: string }> {
  try {
    const { scope } = await getDefaultScope(userId);
    return { orgId: scope.orgId };
  } catch (error) {
    if (!isNotFound(error)) throw error;
    // User has no Clerk org — use sentinel orgId with org_cache entry
    const sentinelOrgId = `org_test_${userId}`;
    const slug = generateDefaultScopeSlug(userId);
    await globalThis.services.db
      .insert(orgCache)
      .values({ orgId: sentinelOrgId, slug, tier: "free" })
      .onConflictDoNothing();
    return { orgId: sentinelOrgId };
  }
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

  // Auto-create scope if user doesn't have one (creates real Clerk org or sentinel)
  const { orgId } = await ensureTestScope(userId);

  // Generate CLI token with org binding
  const randomBytes = crypto.randomBytes(32);
  const token = `vm0_live_${randomBytes.toString("base64url")}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000); // 90 days

  await globalThis.services.db.insert(cliTokens).values({
    token,
    userId,
    name: "CI Test Token",
    orgId,
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
