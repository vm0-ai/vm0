import { NextResponse } from "next/server";
import crypto from "crypto";
import { initServices } from "../../../../../src/lib/init-services";
import { cliTokens } from "../../../../../src/db/schema/cli-tokens";
import {
  getUserScopeByClerkId,
  createUserScope,
  generateDefaultScopeSlug,
} from "../../../../../src/lib/scope/scope-service";
import { isBadRequest } from "../../../../../src/lib/errors";
import { resolveTestUserId } from "../../../../../src/lib/auth/test-user";
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

  const userId = await resolveTestUserId();
  if (!userId) {
    return NextResponse.json({ error: "Test user not found" }, { status: 500 });
  }

  // Auto-create scope if user doesn't have one
  const existingScope = await getUserScopeByClerkId(userId);
  if (!existingScope) {
    const defaultSlug = generateDefaultScopeSlug(userId);
    try {
      await createUserScope(userId, defaultSlug);
    } catch (error) {
      if (isBadRequest(error) && error.message.includes("already exists")) {
        const fallbackSlug = `user-${crypto.randomBytes(4).toString("hex")}`;
        await createUserScope(userId, fallbackSlug);
      } else {
        throw error;
      }
    }
  }

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
