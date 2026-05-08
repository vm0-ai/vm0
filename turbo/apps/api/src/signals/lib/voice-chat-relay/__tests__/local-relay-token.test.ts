import { describe, expect, it } from "vitest";

import { now } from "../../../../lib/time";
import {
  signRelayTokenForTests,
  verifyRelayToken,
  type RelayTokenClaims,
} from "../local-relay-token";

const SECRET = "unit-test-secret-bytes-padding-32!!";

function freshClaims(
  overrides: Partial<RelayTokenClaims> = {},
): RelayTokenClaims {
  return {
    voiceChatSessionId: "00000000-0000-0000-0000-000000000001",
    userId: "user_test",
    orgId: "org_test",
    expiresAt: Math.floor(now() / 1000) + 60,
    ...overrides,
  };
}

describe("verifyRelayToken", () => {
  it("round-trips signed claims", () => {
    const claims = freshClaims();
    const token = signRelayTokenForTests(claims, SECRET);
    const result = verifyRelayToken(token, {
      nowSeconds: Math.floor(now() / 1000),
      secret: SECRET,
    });
    expect(result.ok).toBeTruthy();
    if (result.ok) {
      expect(result.claims).toStrictEqual(claims);
    }
  });

  it("rejects a tampered payload with 4401", () => {
    const claims = freshClaims();
    const token = signRelayTokenForTests(claims, SECRET);
    const dot = token.indexOf(".");
    const sig = token.slice(dot);
    // Tampered payload — different claims, original signature
    const otherToken = signRelayTokenForTests(
      freshClaims({ orgId: "org_other" }),
      SECRET,
    );
    const tamperedPayload = otherToken.slice(0, otherToken.indexOf("."));
    const tampered = `${tamperedPayload}${sig}`;
    const result = verifyRelayToken(tampered, {
      nowSeconds: Math.floor(now() / 1000),
      secret: SECRET,
    });
    expect(result).toStrictEqual({ ok: false, closeCode: 4401 });
  });

  it("rejects an expired token with 4401", () => {
    const claims = freshClaims({
      expiresAt: Math.floor(now() / 1000) - 1,
    });
    const token = signRelayTokenForTests(claims, SECRET);
    const result = verifyRelayToken(token, {
      nowSeconds: Math.floor(now() / 1000),
      secret: SECRET,
    });
    expect(result).toStrictEqual({ ok: false, closeCode: 4401 });
  });

  it("rejects malformed structure with 4400", () => {
    const result = verifyRelayToken("not-a-real-token", {
      nowSeconds: Math.floor(now() / 1000),
      secret: SECRET,
    });
    expect(result).toStrictEqual({ ok: false, closeCode: 4400 });
  });

  it("rejects empty signature with 4400", () => {
    const result = verifyRelayToken("payload.", {
      nowSeconds: Math.floor(now() / 1000),
      secret: SECRET,
    });
    expect(result).toStrictEqual({ ok: false, closeCode: 4400 });
  });

  it("rejects a token signed with a different secret as 4401", () => {
    const claims = freshClaims();
    const token = signRelayTokenForTests(
      claims,
      "different-secret-also-32-bytes-min!",
    );
    const result = verifyRelayToken(token, {
      nowSeconds: Math.floor(now() / 1000),
      secret: SECRET,
    });
    expect(result).toStrictEqual({ ok: false, closeCode: 4401 });
  });
});
