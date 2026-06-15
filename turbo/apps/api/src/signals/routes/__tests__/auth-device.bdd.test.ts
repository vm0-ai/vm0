import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { now } from "../../../lib/time";
import { testContext } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { createBddApi, expectApiError } from "./helpers/api-bdd";
import {
  createAuthDeviceApiActions,
  mockClaudeCodeTokenEndpoint,
  mockCodexDeviceAuthProvider,
} from "./helpers/api-bdd-auth-device";
import { createMiscRoutesApi } from "./helpers/api-bdd-misc";

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
    expect(handoff.body.handoffId).not.toBe("");
    expect(authDevice.callbackHandoffId(handoff.body.callbackUrl)).toBe(
      handoff.body.handoffId,
    );

    const code = authDevice.callbackCode(handoff.body.callbackUrl);
    expect(code).not.toBe("");

    const consumed = await authDevice.requestDesktopConsume(code, [200]);
    expect(consumed.body).toStrictEqual({ token: "ticket_desktop_bdd" });

    const reused = await authDevice.requestDesktopConsume(code, [400]);
    expectApiError(reused.body);
    expect(reused.body.error.message).toBe(
      "Desktop sign-in link is invalid or expired.",
    );

    const patternInvalid = await authDevice.requestDesktopConsume(
      "bad code with spaces!",
      [400],
    );
    expectApiError(patternInvalid.body);
    expect(patternInvalid.body.error.message).toBe(
      "Desktop sign-in link is invalid or expired.",
    );

    const missingCode = await authDevice.requestDesktopConsume("", [400]);
    expectApiError(missingCode.body);
    expect(missingCode.body.error.code).toBe("BAD_REQUEST");
  });

  it("tracks handoff status through consume and complete for the creating user only", async () => {
    authDevice.mockDesktopSignInToken("ticket_desktop_status_bdd");

    const actor = bdd.user();
    const handoff = await authDevice.requestDesktopHandoff(actor, {}, [200]);
    if (handoff.status !== 200) {
      throw new Error(
        `Expected desktop handoff to succeed, got ${handoff.status}`,
      );
    }
    const handoffId = handoff.body.handoffId;

    const pending = await authDevice.requestDesktopHandoffStatus(
      actor,
      handoffId,
      [200],
    );
    expect(pending.body).toStrictEqual({ status: "pending" });

    const foreignStatus = await authDevice.requestDesktopHandoffStatus(
      bdd.user(),
      handoffId,
      [404],
    );
    expectApiError(foreignStatus.body);
    expect(foreignStatus.body.error.code).toBe("NOT_FOUND");

    const unconsumedComplete = await authDevice.requestDesktopHandoffComplete(
      actor,
      handoffId,
      [404],
    );
    expectApiError(unconsumedComplete.body);
    expect(unconsumedComplete.body.error.code).toBe("NOT_FOUND");

    const code = authDevice.callbackCode(handoff.body.callbackUrl);
    const consumed = await authDevice.requestDesktopConsume(code, [200]);
    expect(consumed.body).toStrictEqual({
      token: "ticket_desktop_status_bdd",
    });

    const consumedStatus = await authDevice.requestDesktopHandoffStatus(
      actor,
      handoffId,
      [200],
    );
    expect(consumedStatus.body).toStrictEqual({ status: "consumed" });

    const completed = await authDevice.requestDesktopHandoffComplete(
      actor,
      handoffId,
      [200],
    );
    expect(completed.body).toStrictEqual({ status: "completed" });

    const completedStatus = await authDevice.requestDesktopHandoffStatus(
      actor,
      handoffId,
      [200],
    );
    expect(completedStatus.body).toStrictEqual({ status: "completed" });
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

describe("AUTH-02: platform realtime token", () => {
  it("issues user-scoped realtime tokens only for authenticated users", async () => {
    const unauthenticated = await authDevice.requestPlatformRealtimeToken(
      null,
      [401],
    );
    expectApiError(unauthenticated.body);
    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    const actor = bdd.user();
    const capability = JSON.stringify({
      [`user:${actor.userId}`]: ["subscribe"],
    });
    context.mocks.ably.createTokenRequest.mockResolvedValueOnce({
      keyName: "ably-key",
      timestamp: now(),
      capability,
      clientId: actor.userId,
      nonce: "nonce",
      mac: "mac",
    });

    const token = await authDevice.requestPlatformRealtimeToken(actor, [200]);
    if (token.status !== 200) {
      throw new Error("Expected platform realtime token request to succeed");
    }
    expect(token.body.capability).toBe(capability);
    expect(token.body.clientId).toBe(actor.userId);
    expect(context.mocks.ably.createTokenRequest).toHaveBeenCalledTimes(1);
    expect(context.mocks.ably.createTokenRequest).toHaveBeenCalledWith({
      capability: {
        [`user:${actor.userId}`]: ["subscribe"],
      },
      ttl: 60 * 60 * 1000,
      clientId: actor.userId,
    });
  });
});

describe("MODEL-PROVIDER: device auth boundaries", () => {
  it("starts, polls, and cancels a Codex device auth session through public APIs", async () => {
    let userCodeRequests = 0;
    let tokenPollRequests = 0;
    server.use(
      http.post(
        "https://auth.openai.com/api/accounts/deviceauth/usercode",
        async ({ request }) => {
          userCodeRequests += 1;
          const body: unknown = await request.json();
          expect(body).toMatchObject({
            client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
          });
          return HttpResponse.json({
            device_auth_id: "device-auth-bdd",
            user_code: "CODEX-BDD",
            interval: 7,
          });
        },
      ),
      http.post(
        "https://auth.openai.com/api/accounts/deviceauth/token",
        async ({ request }) => {
          tokenPollRequests += 1;
          const body: unknown = await request.json();
          expect(body).toStrictEqual({
            device_auth_id: "device-auth-bdd",
            user_code: "CODEX-BDD",
          });
          return HttpResponse.text("authorization pending", { status: 403 });
        },
      ),
    );

    const admin = bdd.user();
    const started = await authDevice.requestCodexStart(
      admin,
      "personal",
      [200],
    );
    if (started.status !== 200) {
      throw new Error(
        `Expected Codex device auth start, got ${started.status}`,
      );
    }
    expect(started.body).toMatchObject({
      type: "codex",
      status: "pending",
      scope: "personal",
      browserUrl: "https://auth.openai.com/codex/device",
      verificationCode: "CODEX-BDD",
      interval: 7,
    });
    expect(started.body.sessionToken).toStrictEqual(expect.any(String));
    expect(userCodeRequests).toBe(1);

    const pending = await authDevice.requestCodexComplete(
      admin,
      started.body.sessionToken,
      [200],
    );
    expect(pending.body).toStrictEqual({
      status: "pending",
      errorMessage: null,
    });
    expect(tokenPollRequests).toBe(1);

    const otherUser = bdd.user({ orgId: admin.orgId });
    const crossUserCancel = await authDevice.requestCodexCancel(
      otherUser,
      started.body.sessionToken,
      [404],
    );
    expectApiError(crossUserCancel.body);
    expect(crossUserCancel.body.error.code).toBe("NOT_FOUND");

    const cancelled = await authDevice.requestCodexCancel(
      admin,
      started.body.sessionToken,
      [200],
    );
    expect(cancelled.body).toStrictEqual({ status: "cancelled" });

    const afterCancel = await authDevice.requestCodexComplete(
      admin,
      started.body.sessionToken,
      [200],
    );
    expect(afterCancel.body).toStrictEqual({
      status: "pending",
      errorMessage: "Codex device auth session was cancelled",
    });
  });

  it("starts and cancels a Claude Code device auth session through public APIs", async () => {
    const admin = bdd.user();

    const started = await authDevice.requestClaudeCodeStart(
      admin,
      "personal",
      [200],
    );
    if (started.status !== 200) {
      throw new Error(
        `Expected Claude Code device auth start, got ${started.status}`,
      );
    }
    expect(started.body).toMatchObject({
      type: "claude-code",
      status: "pending",
      scope: "personal",
      expiresIn: expect.any(Number),
    });
    expect(started.body.sessionToken).toStrictEqual(expect.any(String));
    const browserUrl = new URL(started.body.browserUrl);
    expect(browserUrl.origin).toBe("https://claude.com");
    expect(browserUrl.pathname).toBe("/cai/oauth/authorize");
    expect(browserUrl.searchParams.get("response_type")).toBe("code");
    expect(browserUrl.searchParams.get("scope")).toBe("user:inference");

    const wrongState = await authDevice.requestClaudeCodeComplete(
      admin,
      started.body.sessionToken,
      "claude-code-bdd#wrong-state",
      [400],
    );
    expectApiError(wrongState.body);
    expect(wrongState.body.error.message).toBe(
      "Claude Code authorization code belongs to another session",
    );

    const otherUser = bdd.user({ orgId: admin.orgId });
    const crossUserCancel = await authDevice.requestClaudeCodeCancel(
      otherUser,
      started.body.sessionToken,
      [404],
    );
    expectApiError(crossUserCancel.body);
    expect(crossUserCancel.body.error.code).toBe("NOT_FOUND");

    const cancelled = await authDevice.requestClaudeCodeCancel(
      admin,
      started.body.sessionToken,
      [200],
    );
    expect(cancelled.body).toStrictEqual({ status: "cancelled" });

    const afterCancel = await authDevice.requestClaudeCodeComplete(
      admin,
      started.body.sessionToken,
      "claude-code-bdd",
      [400],
    );
    expectApiError(afterCancel.body);
    expect(afterCancel.body.error.message).toBe(
      "Claude Code device auth session is not ready",
    );
  });

  it("completes org-scope Codex device auth and exposes the imported provider", async () => {
    const calls = mockCodexDeviceAuthProvider({ tokenScope: "org" });
    const miscApi = createMiscRoutesApi(context);
    const admin = bdd.user();

    const started = await authDevice.requestCodexStart(admin, "org", [200]);
    if (started.status !== 200) {
      throw new Error(
        `Expected Codex device auth start, got ${started.status}`,
      );
    }
    expect(started.body).toMatchObject({
      type: "codex",
      status: "pending",
      scope: "org",
      browserUrl: "https://auth.openai.com/codex/device",
      verificationCode: "ABCD-EFGH",
      interval: 5,
    });
    expect(calls.userCode).toStrictEqual([
      { client_id: "app_EMoamEEZ73f0CkXaXp7hrann" },
    ]);

    const completed = await authDevice.requestCodexComplete(
      admin,
      started.body.sessionToken,
      [200],
    );
    expect(completed.body).toMatchObject({
      status: "complete",
      created: true,
      provider: {
        type: "codex-oauth-token",
        authMethod: "auth_json",
        workspaceName: "Org Acme",
        planType: "plus",
      },
    });
    expect(calls.deviceToken).toStrictEqual([
      { device_auth_id: "device_auth_test", user_code: "ABCD-EFGH" },
    ]);
    expect(calls.oauthToken).toHaveLength(1);
    const oauthTokenBody = calls.oauthToken[0];
    expect(oauthTokenBody?.get("grant_type")).toBe("authorization_code");
    expect(oauthTokenBody?.get("code")).toBe("auth_code_test");
    expect(oauthTokenBody?.get("redirect_uri")).toBe(
      "https://auth.openai.com/deviceauth/callback",
    );
    expect(oauthTokenBody?.get("client_id")).toBe(
      "app_EMoamEEZ73f0CkXaXp7hrann",
    );
    expect(oauthTokenBody?.get("code_verifier")).toBe("code_verifier_test");

    const providers = await miscApi.listModelProviders(admin);
    expect(
      providers.body.modelProviders.find((provider) => {
        return provider.type === "codex-oauth-token";
      }),
    ).toMatchObject({ workspaceName: "Org Acme", planType: "plus" });

    const reComplete = await authDevice.requestCodexComplete(
      admin,
      started.body.sessionToken,
      [200],
    );
    expect(reComplete.body).toStrictEqual({
      status: "pending",
      errorMessage: null,
    });
    expect(calls.deviceToken).toHaveLength(1);

    await authDevice.deleteOrgModelProvider(admin, "codex-oauth-token");
  });

  it("completes personal-scope Codex device auth for an org member", async () => {
    const calls = mockCodexDeviceAuthProvider({ tokenScope: "personal" });
    const miscApi = createMiscRoutesApi(context);
    const member = bdd.user({ orgRole: "org:member" });

    const started = await authDevice.requestCodexStart(
      member,
      "personal",
      [200],
    );
    if (started.status !== 200) {
      throw new Error(
        `Expected Codex device auth start, got ${started.status}`,
      );
    }

    const completed = await authDevice.requestCodexComplete(
      member,
      started.body.sessionToken,
      [200],
    );
    expect(completed.body).toMatchObject({
      status: "complete",
      provider: {
        type: "codex-oauth-token",
        workspaceName: "Personal Acme",
      },
    });
    expect(calls.deviceToken).toHaveLength(1);

    const personalProviders = await miscApi.listPersonalModelProviders(
      member,
      [200],
    );
    if (!("modelProviders" in personalProviders.body)) {
      throw new Error("Expected personal model provider list response");
    }
    expect(
      personalProviders.body.modelProviders.some((provider) => {
        return provider.type === "codex-oauth-token";
      }),
    ).toBeTruthy();

    await miscApi.deletePersonalModelProvider(
      member,
      "codex-oauth-token",
      [204],
    );
  });

  it("completes org-scope Claude Code device auth with a pasted code fragment", async () => {
    const calls = mockClaudeCodeTokenEndpoint();
    const miscApi = createMiscRoutesApi(context);
    const admin = bdd.user();

    const started = await authDevice.requestClaudeCodeStart(
      admin,
      "org",
      [200],
    );
    if (started.status !== 200) {
      throw new Error(
        `Expected Claude Code device auth start, got ${started.status}`,
      );
    }
    const state = new URL(started.body.browserUrl).searchParams.get("state");
    if (!state) {
      throw new Error("Missing state in Claude Code browser URL");
    }

    const completed = await authDevice.requestClaudeCodeComplete(
      admin,
      started.body.sessionToken,
      `auth_code_test#${state}`,
      [200],
    );
    expect(completed.body).toMatchObject({
      status: "complete",
      created: true,
      provider: {
        type: "claude-code-oauth-token",
        secretName: "CLAUDE_CODE_OAUTH_TOKEN",
      },
    });
    expect(calls.token).toHaveLength(1);
    expect(calls.token[0]).toMatchObject({
      grant_type: "authorization_code",
      code: "auth_code_test",
      redirect_uri: "https://platform.claude.com/oauth/code/callback",
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      state,
      expires_in: 31_536_000,
      code_verifier: expect.any(String),
    });

    const providers = await miscApi.listModelProviders(admin);
    expect(
      providers.body.modelProviders.some((provider) => {
        return provider.type === "claude-code-oauth-token";
      }),
    ).toBeTruthy();

    const reComplete = await authDevice.requestClaudeCodeComplete(
      admin,
      started.body.sessionToken,
      `auth_code_test#${state}`,
      [400],
    );
    expectApiError(reComplete.body);
    expect(reComplete.body.error.message).toBe(
      "Claude Code device auth session is not ready",
    );

    await authDevice.deleteOrgModelProvider(admin, "claude-code-oauth-token");
  });

  it("completes personal-scope Claude Code device auth from a full callback URL", async () => {
    mockClaudeCodeTokenEndpoint();
    const miscApi = createMiscRoutesApi(context);
    const member = bdd.user({ orgRole: "org:member" });

    const started = await authDevice.requestClaudeCodeStart(
      member,
      "personal",
      [200],
    );
    if (started.status !== 200) {
      throw new Error(
        `Expected Claude Code device auth start, got ${started.status}`,
      );
    }
    const state = new URL(started.body.browserUrl).searchParams.get("state");
    if (!state) {
      throw new Error("Missing state in Claude Code browser URL");
    }

    const completed = await authDevice.requestClaudeCodeComplete(
      member,
      started.body.sessionToken,
      `https://platform.claude.com/oauth/code/callback?code=member_code&state=${state}`,
      [200],
    );
    expect(completed.body).toMatchObject({
      status: "complete",
      provider: { type: "claude-code-oauth-token" },
    });

    const personalProviders = await miscApi.listPersonalModelProviders(
      member,
      [200],
    );
    if (!("modelProviders" in personalProviders.body)) {
      throw new Error("Expected personal model provider list response");
    }
    expect(
      personalProviders.body.modelProviders.some((provider) => {
        return provider.type === "claude-code-oauth-token";
      }),
    ).toBeTruthy();

    await miscApi.deletePersonalModelProvider(
      member,
      "claude-code-oauth-token",
      [204],
    );
  });

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
