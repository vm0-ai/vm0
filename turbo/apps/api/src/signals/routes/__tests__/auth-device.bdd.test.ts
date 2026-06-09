import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-helpers";
import { createBddApi, expectApiError } from "./helpers/api-bdd";
import { createAuthDeviceApiActions } from "./helpers/api-bdd-auth-device";

const context = testContext();
const bdd = createBddApi(context);
const authDevice = createAuthDeviceApiActions(context);

interface OAuthErrorBody {
  readonly error: string;
  readonly error_description: string;
}

interface CliApprovalErrorBody {
  readonly success: false;
  readonly error: string;
}

function expectOAuthError(body: unknown): asserts body is OAuthErrorBody {
  if (
    typeof body !== "object" ||
    body === null ||
    !("error" in body) ||
    !("error_description" in body)
  ) {
    throw new Error("Expected OAuth error response body");
  }
}

function expectCliApprovalError(
  body: unknown,
): asserts body is CliApprovalErrorBody {
  if (
    typeof body !== "object" ||
    body === null ||
    !("success" in body) ||
    !("error" in body) ||
    body.success !== false
  ) {
    throw new Error("Expected CLI approval error response body");
  }
}

describe("AUTH-02: CLI device authorization", () => {
  it("starts, polls, approves, exchanges, and uses the issued bearer through public APIs", async () => {
    const actor = bdd.user();

    const started = await authDevice.startCliDevice();
    expect(started.device_code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(started.user_code).toBe(started.device_code);
    expect(started.verification_path).toBe("/cli-auth");
    expect(started.expires_in).toBe(900);
    expect(started.interval).toBe(5);

    const pending = await authDevice.requestCliToken(
      started.device_code,
      [202],
    );
    expectOAuthError(pending.body);
    expect(pending.body.error).toBe("authorization_pending");

    const approved = await authDevice.requestCliApproval(
      actor,
      { device_code: ` ${started.user_code.toLowerCase()} ` },
      [200],
    );
    expect(approved.body).toStrictEqual({ success: true });

    const token = await authDevice.requestCliToken(started.device_code, [200]);
    if (token.status !== 200) {
      throw new Error(
        `Expected CLI token exchange to succeed, got ${token.status}`,
      );
    }
    expect(token.body.token_type).toBe("Bearer");
    expect(token.body.access_token).toMatch(/^vm0_pat_/);

    const me = await authDevice.readMeWithBearer(
      token.body.access_token,
      actor,
      [200],
    );
    expect(me.body).toStrictEqual({
      userId: actor.userId,
      email: actor.email,
    });

    const reused = await authDevice.requestCliToken(started.device_code, [400]);
    expectOAuthError(reused.body);
    expect(reused.body.error).toBe("invalid_request");
  });

  it("returns visible validation and auth errors for bad CLI device requests", async () => {
    const actor = bdd.user();

    const missingDeviceCode = await authDevice.requestCliToken("", [400]);
    expectOAuthError(missingDeviceCode.body);
    expect(missingDeviceCode.body.error).toBe("invalid_request");
    expect(missingDeviceCode.body.error_description).toContain(
      "device_code is required",
    );

    const unknownApproval = await authDevice.requestCliApproval(
      actor,
      { device_code: "ABCD-EFGH" },
      [400],
    );
    expectCliApprovalError(unknownApproval.body);
    expect(unknownApproval.body.error).toBe("Invalid or expired device code");

    const unauthenticatedApproval = await authDevice.requestCliApproval(
      null,
      { device_code: "ABCD-EFGH" },
      [401],
    );
    expectApiError(unauthenticatedApproval.body);
    expect(unauthenticatedApproval.body.error.code).toBe("UNAUTHORIZED");
  });
});

describe("AUTH-02: desktop auth handoff", () => {
  it("requires a session, returns a safe callback URL, and consumes the handoff once", async () => {
    authDevice.mockDesktopSignInToken("ticket_desktop_bdd");

    const unauthenticated = await authDevice.requestDesktopHandoff(
      null,
      {},
      [401],
    );
    expectApiError(unauthenticated.body);
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    const actor = bdd.user();
    const handoff = await authDevice.requestDesktopHandoff(
      actor,
      { callbackScheme: "ai.vm0.zero.desktop.dev" },
      [200],
    );
    if (handoff.status !== 200) {
      throw new Error(
        `Expected desktop handoff to succeed, got ${handoff.status}`,
      );
    }
    const callbackUrl = new URL(handoff.body.callbackUrl);
    expect(callbackUrl.protocol).toBe("ai.vm0.zero.desktop.dev:");
    expect(callbackUrl.hostname).toBe("auth");
    expect(callbackUrl.pathname).toBe("/callback");
    expect(handoff.body.callbackUrl).not.toContain("ticket");
    expect(handoff.body.callbackUrl).not.toContain("token");

    const code = authDevice.callbackCode(handoff.body.callbackUrl);
    expect(code).not.toBe("");

    const consumed = await authDevice.requestDesktopConsume(code, [200]);
    expect(consumed.body).toStrictEqual({ token: "ticket_desktop_bdd" });

    const reused = await authDevice.requestDesktopConsume(code, [400]);
    expectApiError(reused.body);
    expect(reused.body.error.message).toBe(
      "Desktop sign-in link is invalid or expired.",
    );

    const missingCode = await authDevice.requestDesktopConsume("", [400]);
    expectApiError(missingCode.body);
    expect(missingCode.body.error.code).toBe("BAD_REQUEST");
  });
});

describe("AUTH-02: bb0 device token", () => {
  it("creates a device code, exposes pending polling, and gates confirmation through public routes", async () => {
    const created = await authDevice.createDeviceToken({
      device_type: "bb0",
      ble_session_nonce: "ble-session-bdd-001",
    });
    expect(created.device_code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(created.poll_token).toMatch(/^[A-Za-z0-9._-]{32,256}$/);
    expect(created.expires_in).toBe(600);
    expect(created.interval).toBe(3);

    const pending = await authDevice.requestDeviceTokenPoll(
      {
        device_code: created.device_code,
        poll_token: created.poll_token,
      },
      [202],
    );
    expect(pending.body).toStrictEqual({ status: "pending", interval: 3 });

    const wrongPollToken = await authDevice.requestDeviceTokenPoll(
      {
        device_code: created.device_code,
        poll_token: "wrong_poll_token_12345678901234567890",
      },
      [404],
    );
    expect(wrongPollToken.body).toStrictEqual({ status: "invalid" });

    const unauthenticated = await authDevice.requestBb0Confirm(
      null,
      created.device_code,
      [401],
    );
    expectApiError(unauthenticated.body);
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    const noOrg = await authDevice.requestBb0Confirm(
      bdd.user({ orgId: null }),
      created.device_code,
      [400],
    );
    expectApiError(noOrg.body);
    expect(noOrg.body.error.message).toBe("No active organization selected");

    const missingDefaultAgent = await authDevice.requestBb0Confirm(
      bdd.user(),
      created.device_code,
      [400],
    );
    expectApiError(missingDefaultAgent.body);
    expect(missingDefaultAgent.body.error.message).toBe(
      "No default agent configured",
    );
  });

  it("rejects malformed device-token bodies before changing visible state", async () => {
    const invalidCreate = await authDevice.requestDeviceTokenCreate(
      {
        device_type: "bb0",
        ble_session_nonce: "short",
      },
      [400],
    );
    expectApiError(invalidCreate.body);
    expect(invalidCreate.body.error.code).toBe("BAD_REQUEST");

    const invalidPoll = await authDevice.requestDeviceTokenPoll(
      {
        device_code: "BAD-CODE",
        poll_token: "abcdefghijklmnopqrstuvwxyzABCDEF",
      },
      [400],
    );
    expectApiError(invalidPoll.body);
    expect(invalidPoll.body.error.code).toBe("BAD_REQUEST");
  });
});

describe("MODEL-PROVIDER: device auth boundaries", () => {
  it("enforces authentication, active organization, and admin scope boundaries", async () => {
    const noOrg = bdd.user({ orgId: null });
    const member = bdd.user({ orgRole: "org:member" });

    const codexUnauthenticated = await authDevice.requestCodexStart(
      null,
      "org",
      [401],
    );
    expectApiError(codexUnauthenticated.body);
    expect(codexUnauthenticated.body.error.code).toBe("UNAUTHORIZED");

    const codexNoOrg = await authDevice.requestCodexStart(noOrg, "org", [401]);
    expectApiError(codexNoOrg.body);
    expect(codexNoOrg.body.error.code).toBe("UNAUTHORIZED");

    const codexMemberOrg = await authDevice.requestCodexStart(
      member,
      "org",
      [403],
    );
    expectApiError(codexMemberOrg.body);
    expect(codexMemberOrg.body.error.code).toBe("FORBIDDEN");

    const claudeNoOrg = await authDevice.requestClaudeCodeStart(
      noOrg,
      "org",
      [401],
    );
    expectApiError(claudeNoOrg.body);
    expect(claudeNoOrg.body.error.code).toBe("UNAUTHORIZED");

    const claudeMemberOrg = await authDevice.requestClaudeCodeStart(
      member,
      "org",
      [403],
    );
    expectApiError(claudeMemberOrg.body);
    expect(claudeMemberOrg.body.error.code).toBe("FORBIDDEN");
  });

  it("rejects invalid model-provider device session tokens without importing provider state", async () => {
    const admin = bdd.user();

    const codexComplete = await authDevice.requestCodexComplete(
      admin,
      "not-a-session-token",
      [400],
    );
    expectApiError(codexComplete.body);
    expect(codexComplete.body.error.message).toBe(
      "Invalid Codex device auth session token",
    );

    const codexCancel = await authDevice.requestCodexCancel(
      admin,
      "not-a-session-token",
      [400],
    );
    expectApiError(codexCancel.body);
    expect(codexCancel.body.error.message).toBe(
      "Invalid Codex device auth session token",
    );

    const claudeComplete = await authDevice.requestClaudeCodeComplete(
      admin,
      "not-a-session-token",
      "authorization-code#state",
      [400],
    );
    expectApiError(claudeComplete.body);
    expect(claudeComplete.body.error.message).toBe(
      "Invalid Claude Code device auth session token",
    );

    const claudeCancel = await authDevice.requestClaudeCodeCancel(
      admin,
      "not-a-session-token",
      [400],
    );
    expectApiError(claudeCancel.body);
    expect(claudeCancel.body.error.message).toBe(
      "Invalid Claude Code device auth session token",
    );
  });
});
