import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { deviceCodes } from "../../../../../src/db/schema/device-codes";
import { resolveTestUserId } from "../../../../../src/lib/auth/test-user";
import { env } from "../../../../../src/env";

/**
 * Test-only endpoint to approve device codes without browser automation.
 * Only available when USE_MOCK_CLAUDE is set to "true" (CI/test environments).
 *
 * This endpoint:
 * 1. Resolves the test user (via Clerk in SaaS, via default user in self-hosted)
 * 2. Updates the device code status to "authenticated" with the test user ID
 */
export async function POST(req: Request) {
  if (env().USE_MOCK_CLAUDE !== "true") {
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

  const normalizedCode = deviceCode.toUpperCase();

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

  if (new Date() > session.expiresAt) {
    return NextResponse.json(
      { error: "Device code has expired" },
      { status: 400 },
    );
  }

  const testUserId = await resolveTestUserId();
  if (!testUserId) {
    return NextResponse.json({ error: "Test user not found" }, { status: 500 });
  }

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
