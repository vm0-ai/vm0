import { describe, it, expect } from "vitest";
import { decodeCliTokenPayload } from "../cli-token";

function buildCliJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = Buffer.from("fake-signature").toString("base64url");
  return `vm0_sandbox_${header}.${body}.${sig}`;
}

describe("decodeCliTokenPayload", () => {
  it("should decode valid CLI JWT with scope 'cli'", () => {
    const token = buildCliJwt({
      userId: "user-1",
      orgId: "org-1",
      tokenId: "tok-1",
      scope: "cli",
      iat: 1000,
      exp: 2000,
    });
    const result = decodeCliTokenPayload(token);
    expect(result).toEqual({
      userId: "user-1",
      orgId: "org-1",
      tokenId: "tok-1",
      scope: "cli",
      iat: 1000,
      exp: 2000,
    });
  });

  it("should return undefined for vm0_live_ tokens (old format)", () => {
    expect(decodeCliTokenPayload("vm0_live_abc123")).toBeUndefined();
  });

  it("should return undefined for zero-scoped tokens", () => {
    const token = buildCliJwt({
      scope: "zero",
      orgId: "org-1",
      userId: "user-1",
      capabilities: [],
    });
    expect(decodeCliTokenPayload(token)).toBeUndefined();
  });

  it("should return undefined for malformed JWT", () => {
    expect(decodeCliTokenPayload("vm0_sandbox_not.valid")).toBeUndefined();
  });

  it("should return undefined for undefined input", () => {
    expect(decodeCliTokenPayload(undefined)).toBeUndefined();
  });

  it("should return undefined for empty string", () => {
    expect(decodeCliTokenPayload("")).toBeUndefined();
  });

  it("should return undefined when orgId is missing", () => {
    const token = buildCliJwt({ scope: "cli", userId: "user-1" });
    expect(decodeCliTokenPayload(token)).toBeUndefined();
  });

  it("should return undefined when userId is missing", () => {
    const token = buildCliJwt({ scope: "cli", orgId: "org-1" });
    expect(decodeCliTokenPayload(token)).toBeUndefined();
  });

  it("should return undefined for invalid base64 payload", () => {
    expect(
      decodeCliTokenPayload("vm0_sandbox_header.!!!invalid!!!.signature"),
    ).toBeUndefined();
  });
});
