// Local placeholder verifier for the relay token. The real sign+verify pair
// is owned by sub-issue #12140 (mint side) and will land in
// `@vm0/core/voice-chat/relay-token` so apps/web (mint) and apps/api (verify)
// share one HMAC implementation. Until #12140 merges, this file gives the WS
// upgrade endpoint something to call, exercised by tests with a freshly
// signed token.
//
// On rebase after #12140: delete this file and import `verifyRelayToken`
// from `@vm0/core/voice-chat/relay-token` directly. Any consumer importing
// from here should be migrated at the same time.

import { createHmac, timingSafeEqual } from "node:crypto";

import { safeJsonParse } from "../../utils";

export interface RelayTokenClaims {
  readonly voiceChatSessionId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly expiresAt: number;
}

type VerifyResult =
  | { readonly ok: true; readonly claims: RelayTokenClaims }
  | { readonly ok: false; readonly closeCode: 4400 | 4401 };

// No dev fallback secret lives in source — every environment (test, dev,
// preview, prod) must set VOICE_CHAT_RELAY_TOKEN_SECRET. Tests inject via
// `apps/api/src/__tests__/env-stub.ts`; local dev pulls the value through
// `scripts/sync-env.sh` (1Password reference in `apps/web/.env.local.tpl`,
// mirrored into `apps/api/.env.local`). Removing the fallback eliminates the
// secret-scanning false positive that otherwise fires on the literal string.

function base64UrlEncode(input: Buffer): string {
  return input
    .toString("base64")
    .replace(/=+$/u, "")
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_");
}

function base64UrlDecode(input: string): Buffer | null {
  // Buffer.from(..., "base64") is total — invalid characters are dropped
  // rather than throwing — so a syntactic check is enough to reject obvious
  // garbage; for adversarial input the HMAC verification step rejects.
  if (!/^[\w-]*$/u.test(input)) {
    return null;
  }
  const padded = input.replace(/-/gu, "+").replace(/_/gu, "/");
  const padLen = (4 - (padded.length % 4)) % 4;
  return Buffer.from(padded + "=".repeat(padLen), "base64");
}

function hmac(secret: string, payload: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

// Token format: base64url(JSON(claims)) + "." + hex(hmac-sha256(payload))
// — JWT-compact-ish without the header segment. Sub-issue #12140's real
// implementation will reuse this layout so a token signed there verifies
// here without a second migration.

export function signRelayTokenForTests(
  claims: RelayTokenClaims,
  secret: string,
): string {
  const json = JSON.stringify(claims);
  const payload = base64UrlEncode(Buffer.from(json, "utf8"));
  const sig = hmac(secret, payload).toString("hex");
  return `${payload}.${sig}`;
}

function isClaimsShape(value: unknown): value is RelayTokenClaims {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v["voiceChatSessionId"] === "string" &&
    typeof v["userId"] === "string" &&
    typeof v["orgId"] === "string" &&
    typeof v["expiresAt"] === "number"
  );
}

interface VerifyOptions {
  readonly nowSeconds: number;
  readonly secret: string;
}

export function verifyRelayToken(
  token: string,
  options: VerifyOptions,
): VerifyResult {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) {
    return { ok: false, closeCode: 4400 };
  }
  const payload = token.slice(0, dot);
  const sigHex = token.slice(dot + 1);
  // 64 hex chars = 32 bytes (sha-256 output). Reject non-hex / wrong-length
  // signatures syntactically before reaching crypto.
  if (sigHex.length !== 64 || !/^[0-9a-f]+$/u.test(sigHex)) {
    return { ok: false, closeCode: 4400 };
  }
  const sigBuf = Buffer.from(sigHex, "hex");
  if (sigBuf.length !== 32) {
    return { ok: false, closeCode: 4400 };
  }
  const expected = hmac(options.secret, payload);
  if (expected.length !== sigBuf.length || !timingSafeEqual(expected, sigBuf)) {
    return { ok: false, closeCode: 4401 };
  }
  const decoded = base64UrlDecode(payload);
  if (decoded === null) {
    return { ok: false, closeCode: 4400 };
  }
  const parsed = safeJsonParse(decoded.toString("utf8"));
  if (parsed === undefined || !isClaimsShape(parsed)) {
    return { ok: false, closeCode: 4400 };
  }
  if (parsed.expiresAt <= options.nowSeconds) {
    return { ok: false, closeCode: 4401 };
  }
  return { ok: true, claims: parsed };
}
