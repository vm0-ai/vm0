import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNATURE_PREFIX = "sha256=";
const MAX_WEBHOOK_AGE_SECONDS = 300;

export function verifyAgentPhoneWebhook(params: {
  rawBody: string;
  signature: string | null;
  timestamp: string | null;
  secret: string;
}): boolean {
  if (!params.signature || !params.timestamp) return false;

  const timestamp = Number(params.timestamp);
  if (!Number.isFinite(timestamp)) return false;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > MAX_WEBHOOK_AGE_SECONDS) return false;

  const expectedDigest = createHmac("sha256", params.secret)
    .update(`${params.timestamp}.${params.rawBody}`)
    .digest("hex");
  const expected = `${SIGNATURE_PREFIX}${expectedDigest}`;

  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(params.signature);
  if (expectedBuffer.length !== signatureBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, signatureBuffer);
}
