import { randomUUID } from "node:crypto";

import { authContract } from "@vm0/api-contracts/contracts/auth";
import {
  onboardingSetupContract,
  onboardingStatusContract,
  type OnboardingStatusResponse,
} from "@vm0/api-contracts/contracts/onboarding";
import type { ApiErrorResponse } from "@vm0/api-contracts/contracts/errors";
import type { ConnectorType } from "@vm0/connectors/connectors";
import {
  zeroAgentsByIdContract,
  zeroAgentsMainContract,
  type ZeroAgentMetadataRequest,
  type ZeroAgentRequest,
  type ZeroAgentResponse,
} from "@vm0/api-contracts/contracts/zero-agents";
import { zeroOrgContract } from "@vm0/api-contracts/contracts/zero-org";

import {
  accept,
  setupApp,
  type TestContext,
} from "../../../../__tests__/test-helpers";
import { createZeroRouteMocks } from "./zero-route-test";

type ClerkOrgRole = "org:admin" | "org:member";

interface AuthHeaders {
  readonly authorization?: string;
}

interface ClerkUserProfile {
  readonly id: string;
  readonly emailAddresses: readonly {
    readonly id: string;
    readonly emailAddress: string;
  }[];
  readonly primaryEmailAddressId: string;
  readonly firstName: string;
  readonly lastName: string;
}

export interface ApiTestUser {
  readonly userId: string;
  readonly orgId: string | null;
  readonly orgRole: ClerkOrgRole | undefined;
  readonly email: string;
}

export interface ApiTestUserOptions {
  readonly userId?: string;
  readonly orgId?: string | null;
  readonly orgRole?: ClerkOrgRole;
  readonly email?: string;
}

export interface OnboardingSetupBody {
  readonly displayName: string;
  readonly workspaceName?: string;
  readonly sound?: string;
  readonly avatarUrl?: string;
  readonly selectedConnectors?: ConnectorType[];
  readonly timezone?: string;
  readonly role?: string;
}

function authHeaders(user: ApiTestUser | null): AuthHeaders {
  return user ? { authorization: "Bearer clerk-session" } : {};
}

function clerkUserProfile(user: ApiTestUser): ClerkUserProfile {
  const emailId = `email_${user.userId}`;
  return {
    id: user.userId,
    emailAddresses: [{ id: emailId, emailAddress: user.email }],
    primaryEmailAddressId: emailId,
    firstName: "BDD",
    lastName: "User",
  };
}

function createUser(options: ApiTestUserOptions = {}): ApiTestUser {
  const userId = options.userId ?? `user_${randomUUID()}`;
  return {
    userId,
    orgId: options.orgId === undefined ? `org_${randomUUID()}` : options.orgId,
    orgRole:
      options.orgRole ?? (options.orgId === null ? undefined : "org:admin"),
    email: options.email ?? `${userId}@example.test`,
  };
}

export function createBddApi(context: TestContext) {
  const mocks = createZeroRouteMocks(context);

  function authClient() {
    return setupApp({ context })(authContract);
  }

  function onboardingStatusClient() {
    return setupApp({ context })(onboardingStatusContract);
  }

  function onboardingSetupClient() {
    return setupApp({ context })(onboardingSetupContract);
  }

  function orgClient() {
    return setupApp({ context })(zeroOrgContract);
  }

  function agentsClient() {
    return setupApp({ context })(zeroAgentsMainContract);
  }

  function agentsByIdClient() {
    return setupApp({ context })(zeroAgentsByIdContract);
  }

  function user(options: ApiTestUserOptions = {}): ApiTestUser {
    return createUser(options);
  }

  function authenticate(nextUser: ApiTestUser | null): AuthHeaders {
    if (!nextUser) {
      context.mocks.clerk.authenticateRequest.mockResolvedValue({
        isAuthenticated: false,
      });
      return {};
    }

    mocks.clerk.session(nextUser.userId, nextUser.orgId, nextUser.orgRole);
    context.mocks.clerk.users.getUserList.mockResolvedValue({
      data: [clerkUserProfile(nextUser)],
    });
    return authHeaders(nextUser);
  }

  function acceptAgentStorageWrites(): void {
    context.mocks.s3.send.mockResolvedValue({});
  }

  return {
    user,
    acceptAgentStorageWrites,

    async readMe(nextUser: ApiTestUser): Promise<{
      readonly userId: string;
      readonly email: string;
    }> {
      const response = await accept(
        authClient().me({ headers: authenticate(nextUser) }),
        [200],
      );
      return response.body;
    },

    async requestReadMe(
      nextUser: ApiTestUser | null,
      statuses: readonly (200 | 401 | 403 | 404 | 500)[],
    ) {
      return await accept(
        authClient().me({ headers: authenticate(nextUser) }),
        statuses,
      );
    },

    async readOnboardingStatus(
      nextUser: ApiTestUser,
    ): Promise<OnboardingStatusResponse> {
      const response = await accept(
        onboardingStatusClient().getStatus({
          headers: authenticate(nextUser),
        }),
        [200],
      );
      return response.body;
    },

    async requestReadOnboardingStatus(
      nextUser: ApiTestUser | null,
      statuses: readonly (200 | 401)[],
    ) {
      return await accept(
        onboardingStatusClient().getStatus({
          headers: authenticate(nextUser),
        }),
        statuses,
      );
    },

    async setupOnboarding(nextUser: ApiTestUser, body: OnboardingSetupBody) {
      return await accept(
        onboardingSetupClient().setup({
          headers: authenticate(nextUser),
          body,
        }),
        [200, 409],
      );
    },

    async requestReadOrg(
      nextUser: ApiTestUser | null,
      statuses: readonly (200 | 401 | 404)[],
    ) {
      return await accept(
        orgClient().get({ headers: authenticate(nextUser) }),
        statuses,
      );
    },

    async createAgent(
      nextUser: ApiTestUser,
      body: ZeroAgentRequest = {},
    ): Promise<ZeroAgentResponse> {
      const response = await accept(
        agentsClient().create({
          headers: authenticate(nextUser),
          body,
        }),
        [201],
      );
      return response.body;
    },

    async requestCreateAgent(
      nextUser: ApiTestUser | null,
      body: ZeroAgentRequest,
      statuses: readonly (201 | 400 | 401 | 403 | 409 | 422)[],
    ) {
      return await accept(
        agentsClient().create({
          headers: authenticate(nextUser),
          body,
        }),
        statuses,
      );
    },

    async listAgents(
      nextUser: ApiTestUser,
    ): Promise<readonly ZeroAgentResponse[]> {
      const response = await accept(
        agentsClient().list({ headers: authenticate(nextUser) }),
        [200],
      );
      return response.body;
    },

    async readAgent(
      nextUser: ApiTestUser,
      agentId: string,
    ): Promise<ZeroAgentResponse> {
      const response = await accept(
        agentsByIdClient().get({
          params: { id: agentId },
          headers: authenticate(nextUser),
        }),
        [200],
      );
      return response.body;
    },

    async requestReadAgent(
      nextUser: ApiTestUser | null,
      agentId: string,
      statuses: readonly (200 | 400 | 401 | 403 | 404)[],
    ) {
      return await accept(
        agentsByIdClient().get({
          params: { id: agentId },
          headers: authenticate(nextUser),
        }),
        statuses,
      );
    },

    async updateAgentMetadata(
      nextUser: ApiTestUser,
      agentId: string,
      body: ZeroAgentMetadataRequest,
    ): Promise<ZeroAgentResponse> {
      const response = await accept(
        agentsByIdClient().updateMetadata({
          params: { id: agentId },
          headers: authenticate(nextUser),
          body,
        }),
        [200],
      );
      return response.body;
    },

    async updateAgent(
      nextUser: ApiTestUser,
      agentId: string,
      body: ZeroAgentRequest,
    ): Promise<ZeroAgentResponse> {
      const response = await accept(
        agentsByIdClient().update({
          params: { id: agentId },
          headers: authenticate(nextUser),
          body,
        }),
        [200],
      );
      return response.body;
    },

    async deleteAgent(nextUser: ApiTestUser, agentId: string): Promise<void> {
      await accept(
        agentsByIdClient().delete({
          params: { id: agentId },
          headers: authenticate(nextUser),
        }),
        [204],
      );
    },

    async requestDeleteAgent(
      nextUser: ApiTestUser | null,
      agentId: string,
      statuses: readonly (204 | 400 | 401 | 403 | 404 | 409)[],
    ): Promise<{ readonly status: number; readonly body: unknown }> {
      return await accept(
        agentsByIdClient().delete({
          params: { id: agentId },
          headers: authenticate(nextUser),
        }),
        statuses,
      );
    },
  };
}

export function expectApiError(
  body: unknown,
): asserts body is ApiErrorResponse {
  if (
    typeof body !== "object" ||
    body === null ||
    !("error" in body) ||
    typeof body.error !== "object" ||
    body.error === null
  ) {
    throw new Error("Expected API error response body");
  }
}
