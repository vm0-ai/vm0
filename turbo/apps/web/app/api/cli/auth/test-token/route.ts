import { NextResponse } from "next/server";
import crypto from "crypto";
import { initServices } from "../../../../../src/lib/init-services";
import { cliTokens } from "../../../../../src/db/schema/cli-tokens";
import { scopes } from "../../../../../src/db/schema/scope";
import { scopeMembers } from "../../../../../src/db/schema/scope-member";
import {
  getDefaultScopeByClerkUserId,
  generateDefaultScopeSlug,
} from "../../../../../src/lib/scope/scope-service";
import {
  resolveTestUserId,
  isTestVariant,
} from "../../../../../src/lib/auth/test-user";
import { env } from "../../../../../src/env";

/** Sentinel Clerk org ID for test-created scopes (never hits Clerk API) */
const TEST_CLERK_ORG_ID = "org_test_e2e";

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
 * Ensure the test user has a scope, creating one directly in the database
 * if necessary. Unlike the normal createScope flow, this bypasses
 * Clerk Organization creation entirely — test scopes don't need a real
 * Clerk org, and the Clerk Backend API rejects org creation for
 * e2e test users (403 Forbidden).
 */
async function ensureTestScope(userId: string): Promise<void> {
  const existing = await getDefaultScopeByClerkUserId(userId);
  if (existing) return;

  const slug = generateDefaultScopeSlug(userId);

  await globalThis.services.db.transaction(async (tx) => {
    const [newScope] = await tx
      .insert(scopes)
      .values({ slug, clerkOrgId: TEST_CLERK_ORG_ID })
      .onConflictDoNothing({ target: scopes.slug })
      .returning();

    if (!newScope) {
      // Slug conflict — use a random fallback
      const fallbackSlug = `user-${crypto.randomBytes(4).toString("hex")}`;
      const [fallback] = await tx
        .insert(scopes)
        .values({ slug: fallbackSlug, clerkOrgId: TEST_CLERK_ORG_ID })
        .returning();
      if (!fallback) {
        throw new Error("Failed to create test scope with fallback slug");
      }
      await tx.insert(scopeMembers).values({
        scopeId: fallback.id,
        userId,
        role: "admin",
      });
      return;
    }

    await tx.insert(scopeMembers).values({
      scopeId: newScope.id,
      userId,
      role: "admin",
    });
  });
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

  // Auto-create scope if user doesn't have one (bypasses Clerk org creation)
  await ensureTestScope(userId);

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
  });
}
