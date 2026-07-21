import crypto, { timingSafeEqual } from "node:crypto";

import { env } from "../../lib/env";

export const MORNING_BRIEF_PREHEADER =
  "Your schedule, action items, and updates for today.";

const SIGNATURE_HEX_LENGTH = 32;
const SIGNATURE_HEX_PATTERN = /^[0-9a-f]{32}$/;
const TOKEN_PAYLOAD_PREFIX = "morning-brief-unsubscribe:";

function tokenSignature(orgId: string, userId: string): string {
  return crypto
    .createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
    .update(`${TOKEN_PAYLOAD_PREFIX}${orgId}:${userId}`)
    .digest("hex")
    .slice(0, SIGNATURE_HEX_LENGTH);
}

export function buildMorningBriefUnsubscribeUrl(
  orgId: string,
  userId: string,
): string {
  const token = `${orgId}.${userId}.${tokenSignature(orgId, userId)}`;
  return `${env("VM0_WEB_URL")}/api/email/morning-brief/unsubscribe?token=${token}`;
}

export function verifyMorningBriefUnsubscribeToken(
  token: string,
): { readonly orgId: string; readonly userId: string } | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const [orgId, userId, providedHmac] = parts;
  if (!orgId || !userId || !providedHmac) {
    return null;
  }
  if (!SIGNATURE_HEX_PATTERN.test(providedHmac)) {
    return null;
  }
  const expectedHmac = tokenSignature(orgId, userId);
  const isValid = timingSafeEqual(
    Buffer.from(providedHmac),
    Buffer.from(expectedHmac),
  );
  return isValid ? { orgId, userId } : null;
}
