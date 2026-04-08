import { eq, and } from "drizzle-orm";
import crypto from "node:crypto";
import { phoneUserLinks } from "../../../db/schema/phone-user-link";

function hashOtp(otp: string): string {
  return crypto.createHash("sha256").update(otp).digest("hex");
}

/**
 * Send a verification OTP to a phone number via AgentPhone SMS.
 *
 * NOTE: AgentPhone v1 SDK does not expose an outbound SMS send method.
 * This function is intentionally unimplemented until SMS delivery is available.
 */
export async function sendVerificationCode(
  _orgId: string,
  _userId: string,
  _phoneNumber: string,
): Promise<never> {
  throw new Error(
    "SMS verification is not yet supported: AgentPhone SDK does not provide an SMS send method",
  );
}

/**
 * Confirm a verification OTP code.
 */
export async function confirmVerificationCode(
  orgId: string,
  userId: string,
  phoneNumber: string,
  code: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const [link] = await globalThis.services.db
    .select()
    .from(phoneUserLinks)
    .where(
      and(
        eq(phoneUserLinks.phoneNumber, phoneNumber),
        eq(phoneUserLinks.orgId, orgId),
      ),
    )
    .limit(1);

  if (!link) {
    return { success: false, error: "No verification request found." };
  }

  if (link.vm0UserId !== userId) {
    return { success: false, error: "User mismatch." };
  }

  if (!link.otpExpiresAt || link.otpExpiresAt < new Date()) {
    return { success: false, error: "Verification code expired." };
  }

  if (!link.otpHash) {
    return { success: false, error: "No pending verification." };
  }

  const codeHash = hashOtp(code);
  if (codeHash !== link.otpHash) {
    return { success: false, error: "Invalid verification code." };
  }

  // Mark as verified, clear OTP
  await globalThis.services.db
    .update(phoneUserLinks)
    .set({
      verified: true,
      otpHash: null,
      otpExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(eq(phoneUserLinks.id, link.id));

  return { success: true };
}

/**
 * Get a user's verified phone link for an org (if any).
 */
export async function getUserPhoneLink(
  orgId: string,
  userId: string,
): Promise<{
  phoneNumber: string;
  verified: boolean;
} | null> {
  const [link] = await globalThis.services.db
    .select({
      phoneNumber: phoneUserLinks.phoneNumber,
      verified: phoneUserLinks.verified,
    })
    .from(phoneUserLinks)
    .where(
      and(
        eq(phoneUserLinks.orgId, orgId),
        eq(phoneUserLinks.vm0UserId, userId),
      ),
    )
    .limit(1);

  return link ?? null;
}
