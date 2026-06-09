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

import {
  accept,
  setupApp,
  type TestContext,
} from "../../../../__tests__/test-helpers";
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
  };
}
