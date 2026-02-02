import { NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import crypto from "crypto";
import { initServices } from "../../../../../src/lib/init-services";
import { cliTokens } from "../../../../../src/db/schema/cli-tokens";
import {
  getUserScopeByClerkId,
  createUserScope,
  generateDefaultScopeSlug,
} from "../../../../../src/lib/scope/scope-service";
import { isBadRequest } from "../../../../../src/lib/errors";

/**
 * Test-only endpoint to directly generate a CLI token for the test user.
 * Only available when USE_MOCK_CLAUDE is set to "true" (CI/test environments).
 *
 * This endpoint bypasses the device flow entirely and directly creates a token,
 * allowing E2E tests to run without waiting for device flow authentication.
 *
 * The device flow is still tested separately by the e2e-auth job using Playwright.
 */
export async function POST() {
  // Only enabled in test environment
  if (process.env.USE_MOCK_CLAUDE !== "true") {
    return new NextResponse("Not found", { status: 404 });
  }

  initServices();

  // Get test user ID using Clerk Backend API
  const clerk = await clerkClient();
  const { data: users } = await clerk.users.getUserList({
    emailAddress: ["e2e+clerk_test@vm0.ai"],
  });

  const testUser = users[0];
  if (!testUser) {
    return NextResponse.json({ error: "Test user not found" }, { status: 500 });
  }

  const userId = testUser.id;

  // Auto-create scope if user doesn't have one (same logic as token exchange)
  const existingScope = await getUserScopeByClerkId(userId);
  if (!existingScope) {
    const defaultSlug = generateDefaultScopeSlug(userId);
    try {
      await createUserScope(userId, defaultSlug);
    } catch (error) {
      // Handle rare slug collision - retry with random suffix
      if (isBadRequest(error) && error.message.includes("already exists")) {
        const fallbackSlug = `user-${crypto.randomBytes(4).toString("hex")}`;
        await createUserScope(userId, fallbackSlug);
      } else {
        throw error;
      }
    }
  }

  // Generate CLI token (same format as device flow token exchange)
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
    expires_in: 90 * 24 * 60 * 60, // 90 days in seconds
    user_id: userId,
  });
}
