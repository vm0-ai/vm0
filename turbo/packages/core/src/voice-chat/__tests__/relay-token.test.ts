import { describe, it, expect } from "vitest";
import {
  RELAY_TOKEN_TTL_SECONDS,
  signRelayToken,
  verifyRelayToken,
} from "../relay-token";

const SECRET = "00".repeat(32);
const OTHER_SECRET = "ab".repeat(32);

describe("voice-chat relay-token", () => {
  it("signs and verifies a round trip", () => {
    const now = 1_700_000_000;
    const { token, expiresAt } = signRelayToken(
      {
        voiceChatSessionId: "00000000-0000-0000-0000-000000000001",
        userId: "user_42",
        orgId: "org_42",
        noiseReduction: "near_field",
        nowSeconds: now,
      },
      SECRET,
    );
    expect(expiresAt).toBe(now + RELAY_TOKEN_TTL_SECONDS);

    const result = verifyRelayToken(token, SECRET, now);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.claims.voiceChatSessionId).toBe(
      "00000000-0000-0000-0000-000000000001",
    );
    expect(result.claims.userId).toBe("user_42");
    expect(result.claims.orgId).toBe("org_42");
    expect(result.claims.noiseReduction).toBe("near_field");
    expect(result.claims.iat).toBe(now);
    expect(result.claims.exp).toBe(expiresAt);
  });

  it("rejects a token signed with a different secret", () => {
    const { token } = signRelayToken(
      { voiceChatSessionId: "s", userId: "u", nowSeconds: 1_700_000_000 },
      SECRET,
    );
    const result = verifyRelayToken(token, OTHER_SECRET, 1_700_000_000);
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a tampered payload", () => {
    const { token } = signRelayToken(
      { voiceChatSessionId: "s", userId: "u", nowSeconds: 1_700_000_000 },
      SECRET,
    );
    const [, signature] = token.split(".");
    const forged = `${Buffer.from('{"voiceChatSessionId":"x","userId":"u","iat":0,"exp":9999999999}').toString("base64url")}.${signature}`;
    const result = verifyRelayToken(forged, SECRET, 1_700_000_000);
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects an expired token", () => {
    const now = 1_700_000_000;
    const { token, expiresAt } = signRelayToken(
      { voiceChatSessionId: "s", userId: "u", nowSeconds: now, ttlSeconds: 5 },
      SECRET,
    );
    const result = verifyRelayToken(token, SECRET, expiresAt + 1);
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects malformed input", () => {
    expect(verifyRelayToken("no-dot-here", SECRET).ok).toBe(false);
    expect(verifyRelayToken(".only-suffix", SECRET).ok).toBe(false);
    expect(verifyRelayToken("only-prefix.", SECRET).ok).toBe(false);
  });
});
