/**
 * Voice-chat relay bootstrap token (HMAC-SHA256, base64url-encoded).
 *
 * Format: `<base64url(JSON(claims))>.<base64url(hmac))>`.
 *
 * Mint side: apps/web `POST /api/zero/voice-chat/token` (issue #12140).
 * Verify side: apps/api relay endpoint (issue #12139).
 *
 * Env-agnostic: callers pass the shared 32-byte hex secret in. Both sides
 * read `VOICE_CHAT_RELAY_TOKEN_SECRET` from their respective env modules
 * and must agree on the value or verification fails.
 */

import crypto from "crypto";

export const RELAY_TOKEN_TTL_SECONDS = 60;

export interface RelayTokenClaims {
  voiceChatSessionId: string;
  userId: string;
  orgId?: string;
  noiseReduction?: "near_field" | "far_field";
  iat: number;
  exp: number;
}

export type SignInput = Omit<RelayTokenClaims, "iat" | "exp"> & {
  /** Override for tests; defaults to current time. */
  nowSeconds?: number;
  /** Override for tests; defaults to RELAY_TOKEN_TTL_SECONDS. */
  ttlSeconds?: number;
};

export interface SignedRelayToken {
  token: string;
  expiresAt: number;
}

export type VerifyResult =
  | { ok: true; claims: RelayTokenClaims }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

function base64urlEncode(buf: Buffer): string {
  return buf.toString("base64url");
}

function hmac(payload: string, secretHex: string): Buffer {
  return crypto
    .createHmac("sha256", Buffer.from(secretHex, "hex"))
    .update(payload)
    .digest();
}

export function signRelayToken(
  input: SignInput,
  secretHex: string,
): SignedRelayToken {
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const exp = now + (input.ttlSeconds ?? RELAY_TOKEN_TTL_SECONDS);
  const claims: RelayTokenClaims = {
    voiceChatSessionId: input.voiceChatSessionId,
    userId: input.userId,
    orgId: input.orgId,
    noiseReduction: input.noiseReduction,
    iat: now,
    exp,
  };
  const payload = base64urlEncode(Buffer.from(JSON.stringify(claims)));
  const signature = base64urlEncode(hmac(payload, secretHex));
  return { token: `${payload}.${signature}`, expiresAt: exp };
}

export function verifyRelayToken(
  token: string,
  secretHex: string,
  nowSeconds?: number,
): VerifyResult {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) {
    return { ok: false, reason: "malformed" };
  }
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  const expected = base64urlEncode(hmac(payload, secretHex));
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_signature" };
  }

  let claims: RelayTokenClaims;
  try {
    claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as RelayTokenClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    typeof claims.voiceChatSessionId !== "string" ||
    typeof claims.userId !== "string" ||
    typeof claims.iat !== "number" ||
    typeof claims.exp !== "number"
  ) {
    return { ok: false, reason: "malformed" };
  }

  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  if (claims.exp <= now) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, claims };
}
