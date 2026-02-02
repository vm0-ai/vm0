import { NextResponse } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { deviceCodes } from "../../../../../src/db/schema/device-codes";

/**
 * Test-only endpoint to approve device codes without browser automation.
 * Only available when USE_MOCK_CLAUDE is set to "true" (CI/test environments).
 *
 * This endpoint:
 * 1. Looks up the test user via Clerk Backend API (e2e+clerk_test@vm0.ai)
 * 2. Updates the device code status to "authenticated" with the test user ID
 *
 * This replaces Playwright browser automation in CI, removing ~200MB Chromium
 * dependency and making E2E auth faster and more reliable.
 */
export async function POST(req: Request) {
  // Only enabled in test environment
  if (process.env.USE_MOCK_CLAUDE !== "true") {
    return new NextResponse("Not found", { status: 404 });
  }

  initServices();

  const body = (await req.json()) as { device_code?: string };
  const deviceCode = body.device_code;

  if (!deviceCode) {
    return NextResponse.json(
      { error: "device_code required" },
      { status: 400 },
    );
  }

  // Normalize device code to uppercase for case-insensitive matching
  const normalizedCode = deviceCode.toUpperCase();

  // Verify device code exists and is pending
  const [session] = await globalThis.services.db
    .select()
    .from(deviceCodes)
    .where(eq(deviceCodes.code, normalizedCode))
    .limit(1);

  if (!session) {
    return new NextResponse("Not found", { status: 404 });
  }

  if (session.status !== "pending") {
    return NextResponse.json(
      { error: "Device code is not in pending status" },
      { status: 400 },
    );
  }

  // Check if expired
  if (new Date() > session.expiresAt) {
    return NextResponse.json(
      { error: "Device code has expired" },
      { status: 400 },
    );
  }

  // Get test user ID using Clerk Backend API
  const clerk = await clerkClient();
  const { data: users } = await clerk.users.getUserList({
    emailAddress: ["e2e+clerk_test@vm0.ai"],
  });

  const testUser = users[0];
  if (!testUser) {
    return NextResponse.json({ error: "Test user not found" }, { status: 500 });
  }

  const testUserId = testUser.id;

  // Update device code to authenticated
  await globalThis.services.db
    .update(deviceCodes)
    .set({
      status: "authenticated",
      userId: testUserId,
      updatedAt: new Date(),
    })
    .where(eq(deviceCodes.code, normalizedCode));

  return NextResponse.json({ success: true, userId: testUserId });
}
