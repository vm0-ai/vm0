"use server";

import { eq, and } from "drizzle-orm";
import { initServices } from "../../src/lib/init-services";
import { deviceCodes } from "../../src/db/schema/device-codes";
import { getAuthProvider } from "../../src/lib/auth/auth-provider";

interface VerifyResult {
  success: boolean;
  error?: string;
}

export async function verifyDeviceAction(code: string): Promise<VerifyResult> {
  const userId = await getAuthProvider().getUserId();

  if (!userId) {
    return { success: false, error: "Not authenticated" };
  }

  initServices();

  // Normalize code (remove spaces, ensure uppercase)
  const normalizedCode = code.replace(/\s/g, "").toUpperCase();

  const [session] = await globalThis.services.db
    .select()
    .from(deviceCodes)
    .where(
      and(
        eq(deviceCodes.code, normalizedCode),
        eq(deviceCodes.status, "pending"),
      ),
    )
    .limit(1);

  if (!session) {
    return { success: false, error: "Invalid or expired device code" };
  }

  // Check if expired
  if (new Date() > session.expiresAt) {
    return { success: false, error: "Device code has expired" };
  }

  // Update status to authenticated and set userId
  await globalThis.services.db
    .update(deviceCodes)
    .set({
      status: "authenticated",
      userId,
      updatedAt: new Date(),
    })
    .where(eq(deviceCodes.code, normalizedCode));

  return { success: true };
}
