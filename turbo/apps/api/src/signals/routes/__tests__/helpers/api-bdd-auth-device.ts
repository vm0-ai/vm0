import { Buffer } from "node:buffer";

import { authContract } from "@vm0/api-contracts/contracts/auth";
import {
  cliAuthApproveContract,
  cliAuthDeviceContract,
  cliAuthTokenContract,
} from "@vm0/api-contracts/contracts/cli-auth";
import {
  type DesktopAuthCallbackScheme,
  desktopAuthConsumeContract,
  desktopAuthHandoffContract,
} from "@vm0/api-contracts/contracts/desktop-auth";
import {
  bb0DeviceConfirmContract,
  type CreateDeviceTokenRequest,
  deviceTokenContract,
  type PollDeviceTokenRequest,
} from "@vm0/api-contracts/contracts/device-token";
import { platformRealtimeTokenContract } from "@vm0/api-contracts/contracts/realtime";
import {
  type ClaudeCodeDeviceAuthScope,
  zeroClaudeCodeDeviceAuthContract,
} from "@vm0/api-contracts/contracts/zero-claude-code-device-auth";
import {
  type CodexDeviceAuthScope,
  zeroCodexDeviceAuthContract,
} from "@vm0/api-contracts/contracts/zero-codex-device-auth";
import { zeroModelProvidersByTypeContract } from "@vm0/api-contracts/contracts/zero-model-providers";
import { http, HttpResponse } from "msw";

import {
  accept,
  setupApp,
  type TestContext,
} from "../../../../__tests__/test-helpers";
import { now } from "../../../../lib/time";
import { server } from "../../../../mocks/server";
import type { ApiTestUser } from "./api-bdd";
import { createZeroRouteMocks } from "./zero-route-test";

interface AuthHeaders {
  readonly authorization?: string;
}

interface CliApproveBody {
  readonly device_code: string;
  readonly timezone?: string;
}

function authHeaders(actor: ApiTestUser | null): AuthHeaders {
  return actor ? { authorization: "Bearer clerk-session" } : {};
}

function clerkUserProfile(actor: ApiTestUser) {
  const emailId = `email_${actor.userId}`;
  return {
    id: actor.userId,
    emailAddresses: [{ id: emailId, emailAddress: actor.email }],
    primaryEmailAddressId: emailId,
    firstName: "BDD",
    lastName: "Auth",
  };
}

function clerkMemberships(actor: ApiTestUser) {
  if (!actor.orgId) {
    return [];
  }

  return [
    {
      role: actor.orgRole ?? "org:member",
      organization: {
        id: actor.orgId,
        slug: actor.orgId.toLowerCase(),
        name: "BDD Auth Device Org",
      },
      publicUserData: { userId: actor.userId },
      createdAt: Date.parse("2026-01-01T00:00:00.000Z"),
    },
  ];
}

function setClerkReads(context: TestContext, actor: ApiTestUser): void {
  context.mocks.clerk.users.getUserList.mockResolvedValue({
    data: [clerkUserProfile(actor)],
  });
  const memberships = clerkMemberships(actor);
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: memberships,
  });
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    {
      data: memberships,
    },
  );
}

function codeFromCallbackUrl(callbackUrl: string): string {
  return new URL(callbackUrl).searchParams.get("code") ?? "";
}

function base64UrlEncode(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function makeJwt(payload: Record<string, unknown>): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = base64UrlEncode(JSON.stringify(payload));
  return `${header}.${body}.fake-signature`;
}

function makeCodexIdToken(opts: {
  readonly accountId: string;
  readonly planType: string;
  readonly workspaceName: string;
}): string {
  return makeJwt({
    "https://api.openai.com/auth": {
      chatgpt_account_id: opts.accountId,
      chatgpt_plan_type: opts.planType,
      organization: { title: opts.workspaceName },
    },
    exp: Math.floor(now() / 1000) + 3600,
  });
}

function makeCodexTokenResponse(scope: "org" | "personal") {
  return {
    access_token: makeJwt({ exp: Math.floor(now() / 1000) + 7200 }),
    refresh_token: `rt_${scope}_synthetic_high_entropy`,
    id_token: makeCodexIdToken({
      accountId: `ws_acct_from_id_token_${scope}`,
      planType: "plus",
      workspaceName: scope === "org" ? "Org Acme" : "Personal Acme",
    }),
  };
}

interface CodexDeviceAuthProviderRecorder {
  readonly userCode: unknown[];
  readonly deviceToken: unknown[];
  readonly oauthToken: URLSearchParams[];
}

export function mockCodexDeviceAuthProvider(
  options: { readonly tokenScope?: "org" | "personal" } = {},
): CodexDeviceAuthProviderRecorder {
  const recorded: CodexDeviceAuthProviderRecorder = {
    userCode: [],
    deviceToken: [],
    oauthToken: [],
  };

  server.use(
    http.post(
      "https://auth.openai.com/api/accounts/deviceauth/usercode",
      async ({ request }) => {
        recorded.userCode.push(await request.json());
        return HttpResponse.json({
          device_auth_id: "device_auth_test",
          user_code: "ABCD-EFGH",
          interval: "5",
        });
      },
    ),
    http.post(
      "https://auth.openai.com/api/accounts/deviceauth/token",
      async ({ request }) => {
        recorded.deviceToken.push(await request.json());
        return HttpResponse.json({
          authorization_code: "auth_code_test",
          code_challenge: "code_challenge_test",
          code_verifier: "code_verifier_test",
        });
      },
    ),
    http.post("https://auth.openai.com/oauth/token", async ({ request }) => {
      recorded.oauthToken.push(new URLSearchParams(await request.text()));
      return HttpResponse.json(
        makeCodexTokenResponse(options.tokenScope ?? "org"),
      );
    }),
  );

  return recorded;
}

interface ClaudeCodeTokenEndpointRecorder {
  readonly token: unknown[];
}

export function mockClaudeCodeTokenEndpoint(): ClaudeCodeTokenEndpointRecorder {
  const recorded: ClaudeCodeTokenEndpointRecorder = { token: [] };

  server.use(
    http.post(
      "https://platform.claude.com/v1/oauth/token",
      async ({ request }) => {
        recorded.token.push(await request.json());
        return HttpResponse.json({
          access_token: "claude-code-access-token",
          expires_in: 31_536_000,
          scope: "user:inference",
        });
      },
    ),
  );

  return recorded;
}

export function createAuthDeviceApiActions(context: TestContext) {
  const routeMocks = createZeroRouteMocks(context);

  function authenticate(actor: ApiTestUser | null): AuthHeaders {
    if (!actor) {
      context.mocks.clerk.authenticateRequest.mockResolvedValue({
        isAuthenticated: false,
      });
      return {};
    }

    routeMocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    setClerkReads(context, actor);
    return authHeaders(actor);
  }

  return {
    callbackCode: codeFromCallbackUrl,

    mockDesktopSignInToken(token: string): void {
      context.mocks.clerk.signInTokens.createSignInToken.mockResolvedValue({
        token,
      });
    },

    async startCliDevice() {
      const client = setupApp({ context })(cliAuthDeviceContract);
      const response = await accept(client.create({ body: {} }), [200]);
      return response.body;
    },

    async requestCliToken(
      deviceCode: string,
      statuses: readonly (200 | 202 | 400 | 500)[],
    ) {
      const client = setupApp({ context })(cliAuthTokenContract);
      return await accept(
        client.exchange({ body: { device_code: deviceCode } }),
        statuses,
      );
    },

    async requestCliApproval(
      actor: ApiTestUser | null,
      body: CliApproveBody,
      statuses: readonly (200 | 400 | 401 | 403)[],
    ) {
      const client = setupApp({ context })(cliAuthApproveContract);
      return await accept(
        client.approve({ headers: authenticate(actor), body }),
        statuses,
      );
    },

    async readMeWithBearer(
      token: string,
      actor: ApiTestUser,
      statuses: readonly (200 | 401 | 403 | 404 | 500)[],
    ) {
      setClerkReads(context, actor);
      const client = setupApp({ context })(authContract);
      return await accept(
        client.me({ headers: { authorization: `Bearer ${token}` } }),
        statuses,
      );
    },

    async requestDesktopHandoff(
      actor: ApiTestUser | null,
      body: { readonly callbackScheme?: DesktopAuthCallbackScheme } | undefined,
      statuses: readonly (200 | 400 | 401 | 403 | 500)[],
    ) {
      const client = setupApp({ context })(desktopAuthHandoffContract);
      return await accept(
        client.create({ headers: authenticate(actor), body: body ?? {} }),
        statuses,
      );
    },

    async requestDesktopConsume(
      code: string,
      statuses: readonly (200 | 400 | 500)[],
    ) {
      const client = setupApp({ context })(desktopAuthConsumeContract);
      return await accept(client.consume({ body: { code } }), statuses);
    },

    async createDeviceToken(body: CreateDeviceTokenRequest) {
      const client = setupApp({ context })(deviceTokenContract);
      const response = await accept(client.create({ body }), [200]);
      return response.body;
    },

    async requestDeviceTokenCreate(
      body: CreateDeviceTokenRequest,
      statuses: readonly (200 | 400)[],
    ) {
      const client = setupApp({ context })(deviceTokenContract);
      return await accept(client.create({ body }), statuses);
    },

    async requestDeviceTokenPoll(
      body: PollDeviceTokenRequest,
      statuses: readonly (200 | 202 | 400 | 404 | 410)[],
    ) {
      const client = setupApp({ context })(deviceTokenContract);
      return await accept(client.poll({ body }), statuses);
    },

    async requestBb0Confirm(
      actor: ApiTestUser | null,
      deviceCode: string,
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ) {
      const client = setupApp({ context })(bb0DeviceConfirmContract);
      return await accept(
        client.confirm({
          headers: authenticate(actor),
          body: { device_code: deviceCode },
        }),
        statuses,
      );
    },

    async requestPlatformRealtimeToken(
      actor: ApiTestUser | null,
      statuses: readonly (200 | 401 | 500)[],
    ) {
      const client = setupApp({ context })(platformRealtimeTokenContract);
      return await accept(
        client.create({ headers: authenticate(actor), body: {} }),
        statuses,
      );
    },

    async requestCodexStart(
      actor: ApiTestUser | null,
      scope: CodexDeviceAuthScope,
      statuses: readonly (200 | 400 | 401 | 403 | 503)[],
    ) {
      const client = setupApp({ context })(zeroCodexDeviceAuthContract);
      return await accept(
        client.start({ headers: authenticate(actor), body: { scope } }),
        statuses,
      );
    },

    async requestCodexComplete(
      actor: ApiTestUser | null,
      sessionToken: string,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 503)[],
    ) {
      const client = setupApp({ context })(zeroCodexDeviceAuthContract);
      return await accept(
        client.complete({
          headers: authenticate(actor),
          body: { sessionToken },
        }),
        statuses,
      );
    },

    async requestCodexCancel(
      actor: ApiTestUser | null,
      sessionToken: string,
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ) {
      const client = setupApp({ context })(zeroCodexDeviceAuthContract);
      return await accept(
        client.cancel({
          headers: authenticate(actor),
          body: { sessionToken },
        }),
        statuses,
      );
    },

    async requestClaudeCodeStart(
      actor: ApiTestUser | null,
      scope: ClaudeCodeDeviceAuthScope,
      statuses: readonly (200 | 400 | 401 | 403 | 503)[],
    ) {
      const client = setupApp({ context })(zeroClaudeCodeDeviceAuthContract);
      return await accept(
        client.start({ headers: authenticate(actor), body: { scope } }),
        statuses,
      );
    },

    async requestClaudeCodeComplete(
      actor: ApiTestUser | null,
      sessionToken: string,
      authorizationCode: string,
      statuses: readonly (200 | 400 | 401 | 403 | 404 | 503)[],
    ) {
      const client = setupApp({ context })(zeroClaudeCodeDeviceAuthContract);
      return await accept(
        client.complete({
          headers: authenticate(actor),
          body: { sessionToken, authorizationCode },
        }),
        statuses,
      );
    },

    async requestClaudeCodeCancel(
      actor: ApiTestUser | null,
      sessionToken: string,
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ) {
      const client = setupApp({ context })(zeroClaudeCodeDeviceAuthContract);
      return await accept(
        client.cancel({
          headers: authenticate(actor),
          body: { sessionToken },
        }),
        statuses,
      );
    },

    async deleteOrgModelProvider(
      actor: ApiTestUser,
      type: "claude-code-oauth-token" | "codex-oauth-token",
    ): Promise<void> {
      const client = setupApp({ context })(zeroModelProvidersByTypeContract);
      await accept(
        client.delete({
          params: { type },
          headers: authenticate(actor),
        }),
        [204],
      );
    },
  };
}
