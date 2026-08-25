import crypto, { timingSafeEqual } from "node:crypto";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import {
  apiUrlForPublicBrand,
  appUrlForPublicBrand,
} from "@okouai/core/public-brand";

import { apiBackendUrl } from "../../lib/api-backend-url";
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

function buildToken(orgId: string, userId: string): string {
  return `${orgId}.${userId}.${tokenSignature(orgId, userId)}`;
}

/**
 * One-click List-Unsubscribe target for email headers. Mail providers POST
 * to this URL directly, so it must stay on the API origin.
 */
export function buildMorningBriefUnsubscribeUrl(
  orgId: string,
  userId: string,
  publicBrand: PublicBrand = "vm0",
): string {
  const apiUrl = apiUrlForPublicBrand(
    apiBackendUrl() ?? env("VM0_WEB_URL"),
    publicBrand,
  );
  return `${apiUrl}/api/email/morning-brief/unsubscribe?token=${buildToken(orgId, userId)}`;
}

/**
 * Human-facing unsubscribe page in the platform app, used for links inside
 * the email body. The page performs the actual unsubscribe via the API.
 */
export function buildMorningBriefUnsubscribePageUrl(
  orgId: string,
  userId: string,
  publicBrand: PublicBrand = "vm0",
): string {
  return `${appUrlForPublicBrand(env("APP_URL"), publicBrand)}/email/morning-brief/unsubscribe?token=${buildToken(orgId, userId)}`;
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
