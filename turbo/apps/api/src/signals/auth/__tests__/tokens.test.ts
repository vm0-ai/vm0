import { describe, expect, it } from "vitest";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";

import {
  generateZeroToken,
  isPatToken,
  isSandboxToken,
  signPatJwtForTests,
  signSandboxJwtForTests,
  verifyCliToken,
  verifyComposeJobToken,
  verifySandboxToken,
  verifyZeroToken,
} from "../tokens";
import { now } from "../../../lib/time";
import { safeJsonParse } from "../../utils";

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function decodeZeroTokenPayloadForTest(token: string): Record<string, unknown> {
  const payload = token.slice("vm0_sandbox_".length).split(".")[1];
  if (!payload) {
    throw new Error("Expected a signed Zero token payload");
  }
  const parsed = safeJsonParse(Buffer.from(payload, "base64url").toString());
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected a signed Zero token object payload");
  }
  return Object.fromEntries(Object.entries(parsed));
}

describe("auth tokens", () => {
  it("verifies PAT CLI tokens", () => {
    const nowSeconds = currentSecond();
    const token = signPatJwtForTests({
      scope: "cli",
      userId: "user_pat",
      orgId: "org_pat",
      tokenId: "token_pat",
      iat: nowSeconds,
      exp: nowSeconds + 60,
    });

    expect(isPatToken(token)).toBeTruthy();
    expect(verifyCliToken(token)).toStrictEqual({
      userId: "user_pat",
      orgId: "org_pat",
      tokenId: "token_pat",
    });
  });

  it("verifies sandbox, zero, and okou tokens behind the sandbox prefix", () => {
    const nowSeconds = currentSecond();
    const sandboxToken = signSandboxJwtForTests({
      scope: "sandbox",
      userId: "user_sandbox",
      orgId: "org_sandbox",
      runId: "run_sandbox",
      iat: nowSeconds,
      exp: nowSeconds + 60,
    });

    const zeroToken = signSandboxJwtForTests({
      scope: "zero",
      userId: "user_zero",
      orgId: "org_zero",
      runId: "run_zero",
      capabilities: ["file:read"],
      iat: nowSeconds,
      exp: nowSeconds + 60,
    });
    const okouToken = signSandboxJwtForTests({
      scope: "okou",
      userId: "user_okou",
      orgId: "org_okou",
      runId: "run_okou",
      capabilities: ["file:write"],
      iat: nowSeconds,
      exp: nowSeconds + 60,
    });

    expect(isSandboxToken(sandboxToken)).toBeTruthy();
    expect(verifySandboxToken(sandboxToken)).toStrictEqual({
      userId: "user_sandbox",
      orgId: "org_sandbox",
      runId: "run_sandbox",
    });
    expect(verifyZeroToken(zeroToken)).toStrictEqual({
      userId: "user_zero",
      orgId: "org_zero",
      runId: "run_zero",
      capabilities: ["file:read"],
    });
    expect(verifyZeroToken(okouToken)).toStrictEqual({
      userId: "user_okou",
      orgId: "org_okou",
      runId: "run_okou",
      capabilities: ["file:write"],
    });
  });

  it("generates either run token scope without changing the prefix", () => {
    const zeroToken = generateZeroToken("user_zero", "run_zero", "org_zero");
    const okouToken = generateZeroToken(
      "user_okou",
      "run_okou",
      "org_okou",
      undefined,
      { scope: "okou" },
    );

    expect(zeroToken).toMatch(/^vm0_sandbox_/u);
    expect(okouToken).toMatch(/^vm0_sandbox_/u);
    expect(decodeZeroTokenPayloadForTest(zeroToken)).toMatchObject({
      scope: "zero",
    });
    expect(decodeZeroTokenPayloadForTest(okouToken)).toMatchObject({
      scope: "okou",
    });
    expect(verifyZeroToken(okouToken)).toMatchObject({
      userId: "user_okou",
      runId: "run_okou",
      orgId: "org_okou",
    });
  });

  it("generates one Okou-scoped run token with the complete run claims", () => {
    const computerUseHostId = "00000000-0000-4000-8000-000000000001";
    const okouToken = generateZeroToken(
      "user_shared",
      "run_shared",
      "org_shared",
      { [FeatureSwitchKey.Banking]: true },
      {
        scope: "okou",
        computerUseHostId,
        cloudBrowserEnabled: true,
        imageRecognitionAvailable: true,
      },
    );

    const okouPayload = decodeZeroTokenPayloadForTest(okouToken);
    expect(okouPayload).toMatchObject({
      scope: "okou",
      userId: "user_shared",
      runId: "run_shared",
      orgId: "org_shared",
      computerUseHostId,
      cloudBrowserEnabled: true,
      capabilities: expect.arrayContaining([
        "banking:read",
        "browser:read",
        "browser:write",
        "computer-use:write",
        "image-recognition:write",
      ]),
      iat: expect.any(Number),
      exp: expect.any(Number),
    });
    expect(okouPayload.exp).toBe(Number(okouPayload.iat) + 2 * 60 * 60);
    expect(verifyZeroToken(okouToken)).toMatchObject({
      userId: "user_shared",
      runId: "run_shared",
      orgId: "org_shared",
      computerUseHostId,
      cloudBrowserEnabled: true,
    });
  });

  it("ignores unknown zero capabilities while preserving known capabilities", () => {
    const nowSeconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "zero",
      userId: "user_zero",
      orgId: "org_zero",
      runId: "run_zero",
      capabilities: ["file:read", "future:read", "file:write"],
      iat: nowSeconds,
      exp: nowSeconds + 60,
    });

    expect(verifyZeroToken(token)).toStrictEqual({
      userId: "user_zero",
      orgId: "org_zero",
      runId: "run_zero",
      capabilities: ["file:read", "file:write"],
    });
  });

  it("rejects expired tokens and mismatched scopes", () => {
    const nowSeconds = currentSecond();
    const expiredToken = signPatJwtForTests({
      scope: "cli",
      userId: "user_expired",
      orgId: "org_expired",
      tokenId: "token_expired",
      iat: nowSeconds - 120,
      exp: nowSeconds - 60,
    });
    const composeJobToken = signSandboxJwtForTests({
      scope: "compose-job",
      userId: "user_compose",
      jobId: "job_compose",
      iat: nowSeconds,
      exp: nowSeconds + 60,
    });

    expect(verifyCliToken(expiredToken)).toBeNull();
    expect(verifySandboxToken(composeJobToken)).toBeNull();
    expect(verifyZeroToken(composeJobToken)).toBeNull();
    expect(verifyComposeJobToken(composeJobToken)).toStrictEqual({
      userId: "user_compose",
      jobId: "job_compose",
    });
  });

  it("includes maps capability in zero-scoped tokens", () => {
    const token = generateZeroToken("user_zero", "run_zero", "org_zero");

    expect(verifyZeroToken(token)?.capabilities).toContain("maps:read");
  });

  it("includes weather capability in zero-scoped tokens", () => {
    const token = generateZeroToken("user_zero", "run_zero", "org_zero");

    expect(verifyZeroToken(token)?.capabilities).toContain("weather:read");
  });

  it("includes chat thread read and write capabilities in zero-scoped tokens", () => {
    const token = generateZeroToken("user_zero", "run_zero", "org_zero");

    expect(verifyZeroToken(token)?.capabilities).toContain("chat-thread:read");
    expect(verifyZeroToken(token)?.capabilities).toContain("chat-thread:write");
  });

  it("includes chat event read and write capabilities in zero-scoped tokens", () => {
    const token = generateZeroToken("user_zero", "run_zero", "org_zero");

    expect(decodeZeroTokenPayloadForTest(token)).toMatchObject({
      capabilities: expect.arrayContaining([
        "chat-event:read",
        "chat-event:write",
      ]),
    });
    expect(verifyZeroToken(token)?.capabilities).toContain("chat-event:read");
    expect(verifyZeroToken(token)?.capabilities).toContain("chat-event:write");
  });

  it("gates banking capability behind the banking feature switch", () => {
    const defaultToken = generateZeroToken("user_zero", "run_zero", "org_zero");
    const enabledToken = generateZeroToken(
      "user_zero",
      "run_zero",
      "org_zero",
      { [FeatureSwitchKey.Banking]: true },
    );

    expect(verifyZeroToken(defaultToken)?.capabilities).not.toContain(
      "banking:read",
    );
    expect(verifyZeroToken(enabledToken)?.capabilities).toContain(
      "banking:read",
    );
  });

  it("grants custom connector writes by default", () => {
    const token = generateZeroToken("user_zero", "run_zero", "org_zero");

    expect(verifyZeroToken(token)?.capabilities).toContain("connector:write");
  });

  it("grants scrape capability by default", () => {
    const token = generateZeroToken("user_zero", "run_zero", "org_zero");

    expect(verifyZeroToken(token)?.capabilities).toContain("scrape:read");
  });

  it("grants web-search capability by default", () => {
    const token = generateZeroToken("user_zero", "run_zero", "org_zero");

    expect(verifyZeroToken(token)?.capabilities).toContain("web-search:read");
  });

  it("grants finance capability by default", () => {
    const token = generateZeroToken("user_zero", "run_zero", "org_zero");

    expect(verifyZeroToken(token)?.capabilities).toContain("finance:read");
  });

  it("grants SEO capability by default", () => {
    const token = generateZeroToken("user_zero", "run_zero", "org_zero");

    expect(verifyZeroToken(token)?.capabilities).toContain("seo:read");
  });

  it("includes people-search capability in zero-scoped tokens", () => {
    const token = generateZeroToken("user_zero", "run_zero", "org_zero");

    expect(verifyZeroToken(token)?.capabilities).toContain(
      "people-search:read",
    );
  });

  it("grants translation capability by default", () => {
    const token = generateZeroToken("user_zero", "run_zero", "org_zero");

    expect(verifyZeroToken(token)?.capabilities).toContain("translation:write");
  });

  it("gates image recognition on run eligibility", () => {
    const staffOrgId = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";
    const ineligibleToken = generateZeroToken(
      "user_zero",
      "run_zero",
      staffOrgId,
    );
    const eligibleToken = generateZeroToken(
      "user_zero",
      "run_zero",
      staffOrgId,
      undefined,
      { imageRecognitionAvailable: true },
    );
    expect(verifyZeroToken(ineligibleToken)?.capabilities).not.toContain(
      "image-recognition:write",
    );
    expect(verifyZeroToken(eligibleToken)?.capabilities).toContain(
      "image-recognition:write",
    );
  });

  it("gates browser capabilities on thread access", () => {
    const defaultToken = generateZeroToken("user_zero", "run_zero", "org_zero");
    const enabledToken = generateZeroToken(
      "user_zero",
      "run_zero",
      "org_zero",
      undefined,
      { cloudBrowserEnabled: true },
    );

    expect(verifyZeroToken(defaultToken)?.capabilities).not.toContain(
      "browser:read",
    );
    expect(verifyZeroToken(defaultToken)?.capabilities).not.toContain(
      "browser:write",
    );
    expect(verifyZeroToken(enabledToken)).toMatchObject({
      cloudBrowserEnabled: true,
      capabilities: expect.arrayContaining(["browser:read", "browser:write"]),
    });
  });

  it("grants all goal capabilities", () => {
    const defaultToken = generateZeroToken("user_zero", "run_zero", "org_zero");

    expect(verifyZeroToken(defaultToken)?.capabilities).toContain("goal:read");
    expect(verifyZeroToken(defaultToken)?.capabilities).toContain(
      "goal:agent-result:write",
    );
    expect(verifyZeroToken(defaultToken)?.capabilities).toContain(
      "goal:user-control:write",
    );
  });

  it("gates computer-use capability on an explicit host grant", () => {
    const defaultToken = generateZeroToken("user_zero", "run_zero", "org_zero");
    const scopedToken = generateZeroToken(
      "user_zero",
      "run_zero",
      "org_zero",
      undefined,
      { computerUseHostId: "00000000-0000-4000-8000-000000000001" },
    );

    expect(verifyZeroToken(defaultToken)?.capabilities).not.toContain(
      "computer-use:write",
    );
    expect(verifyZeroToken(defaultToken)?.computerUseHostId).toBeUndefined();
    expect(verifyZeroToken(scopedToken)).toMatchObject({
      computerUseHostId: "00000000-0000-4000-8000-000000000001",
      capabilities: expect.arrayContaining(["computer-use:write"]),
    });
  });
});
