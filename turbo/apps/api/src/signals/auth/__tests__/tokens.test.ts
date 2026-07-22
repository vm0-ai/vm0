import { describe, expect, it } from "vitest";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";

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
import { now } from "../../external/time";

function currentSecond(): number {
  return Math.floor(now() / 1000);
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

  it("verifies sandbox and zero tokens behind the sandbox prefix", () => {
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
    expect(verifyComposeJobToken(composeJobToken)).toStrictEqual({
      userId: "user_compose",
      jobId: "job_compose",
    });
  });

  it("includes maps capability in zero-scoped tokens", () => {
    const token = generateZeroToken("user_zero", "run_zero", "org_zero");

    expect(verifyZeroToken(token)?.capabilities).toContain("maps:read");
  });

  it("includes chat thread read and write capabilities in zero-scoped tokens", () => {
    const token = generateZeroToken("user_zero", "run_zero", "org_zero");

    expect(verifyZeroToken(token)?.capabilities).toContain("chat-thread:read");
    expect(verifyZeroToken(token)?.capabilities).toContain("chat-thread:write");
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

  it("grants scrape capability from user feature switch overrides", () => {
    const defaultToken = generateZeroToken("user_zero", "run_zero", "org_zero");
    const overrideToken = generateZeroToken(
      "user_zero",
      "run_zero",
      "org_zero",
      { [FeatureSwitchKey.ZeroScrape]: true },
    );

    expect(verifyZeroToken(defaultToken)?.capabilities).not.toContain(
      "scrape:read",
    );
    expect(verifyZeroToken(overrideToken)?.capabilities).toContain(
      "scrape:read",
    );
  });

  it("grants web-search capability from user feature switch overrides", () => {
    const defaultToken = generateZeroToken("user_zero", "run_zero", "org_zero");
    const overrideToken = generateZeroToken(
      "user_zero",
      "run_zero",
      "org_zero",
      { [FeatureSwitchKey.ZeroWebSearch]: true },
    );

    expect(verifyZeroToken(defaultToken)?.capabilities).not.toContain(
      "web-search:read",
    );
    expect(verifyZeroToken(overrideToken)?.capabilities).toContain(
      "web-search:read",
    );
  });

  it("grants goal capabilities by default", () => {
    const defaultToken = generateZeroToken("user_zero", "run_zero", "org_zero");

    expect(verifyZeroToken(defaultToken)?.capabilities).toContain("goal:read");
    expect(verifyZeroToken(defaultToken)?.capabilities).toContain(
      "goal:agent-result:write",
    );
    expect(verifyZeroToken(defaultToken)?.capabilities).toContain(
      "goal:user-control:write",
    );
  });

  it("excludes user-control goal writes for workflow-event runs but keeps agent result writes", () => {
    const userDrivenToken = generateZeroToken(
      "user_zero",
      "run_zero",
      "org_zero",
      {},
      { triggerSource: "web" },
    );
    const continuationToken = generateZeroToken(
      "user_zero",
      "run_zero",
      "org_zero",
      {},
      { triggerSource: "workflow-event" },
    );

    expect(verifyZeroToken(userDrivenToken)?.capabilities).toContain(
      "goal:user-control:write",
    );
    expect(verifyZeroToken(continuationToken)?.capabilities).not.toContain(
      "goal:user-control:write",
    );
    expect(verifyZeroToken(continuationToken)?.capabilities).toContain(
      "goal:read",
    );
    expect(verifyZeroToken(continuationToken)?.capabilities).toContain(
      "goal:agent-result:write",
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
