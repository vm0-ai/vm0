import { describe, it, expect } from "vitest";
import { createHmac } from "crypto";
import { verifySlackSignature, getSlackSignatureHeaders } from "../verify";

describe("verifySlackSignature", () => {
  const signingSecret = "8f742231b10e8888abcd99yyyzzz85a5";

  it("should return true for valid signature", () => {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const body = "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J";

    // Compute expected signature
    const baseString = `v0:${timestamp}:${body}`;
    const hmac = createHmac("sha256", signingSecret);
    const signature = `v0=${hmac.update(baseString).digest("hex")}`;

    const result = verifySlackSignature(
      signingSecret,
      signature,
      timestamp,
      body,
    );
    expect(result).toBe(true);
  });

  it("should return false for invalid signature", () => {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const body = "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J";
    const invalidSignature = "v0=invalid_signature";

    const result = verifySlackSignature(
      signingSecret,
      invalidSignature,
      timestamp,
      body,
    );
    expect(result).toBe(false);
  });

  it("should return false for old timestamp (replay attack protection)", () => {
    // Timestamp from 10 minutes ago
    const oldTimestamp = (Math.floor(Date.now() / 1000) - 600).toString();
    const body = "test=body";

    const baseString = `v0:${oldTimestamp}:${body}`;
    const hmac = createHmac("sha256", signingSecret);
    const signature = `v0=${hmac.update(baseString).digest("hex")}`;

    const result = verifySlackSignature(
      signingSecret,
      signature,
      oldTimestamp,
      body,
    );
    expect(result).toBe(false);
  });

  it("should return false for tampered body", () => {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const originalBody = "original=body";
    const tamperedBody = "tampered=body";

    const baseString = `v0:${timestamp}:${originalBody}`;
    const hmac = createHmac("sha256", signingSecret);
    const signature = `v0=${hmac.update(baseString).digest("hex")}`;

    const result = verifySlackSignature(
      signingSecret,
      signature,
      timestamp,
      tamperedBody,
    );
    expect(result).toBe(false);
  });
});

describe("getSlackSignatureHeaders", () => {
  it("should return signature and timestamp when both headers present", () => {
    const headers = new Headers({
      "x-slack-signature": "v0=abc123",
      "x-slack-request-timestamp": "1234567890",
    });

    const result = getSlackSignatureHeaders(headers);
    expect(result).toEqual({
      signature: "v0=abc123",
      timestamp: "1234567890",
    });
  });

  it("should return null when signature header is missing", () => {
    const headers = new Headers({
      "x-slack-request-timestamp": "1234567890",
    });

    const result = getSlackSignatureHeaders(headers);
    expect(result).toBeNull();
  });

  it("should return null when timestamp header is missing", () => {
    const headers = new Headers({
      "x-slack-signature": "v0=abc123",
    });

    const result = getSlackSignatureHeaders(headers);
    expect(result).toBeNull();
  });
});
