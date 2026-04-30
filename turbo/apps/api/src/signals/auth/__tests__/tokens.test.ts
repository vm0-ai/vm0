import { describe, expect, it } from "vitest";

import {
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
});
