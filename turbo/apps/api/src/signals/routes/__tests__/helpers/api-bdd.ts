import { randomUUID } from "node:crypto";

import { authContract } from "@vm0/api-contracts/contracts/auth";
import {
  onboardingCompleteContract,
  onboardingStatusContract,
  type OnboardingStatusResponse,
} from "@vm0/api-contracts/contracts/onboarding";
import type { ApiErrorResponse } from "@vm0/api-contracts/contracts/errors";
import {
  zeroAgentsByIdContract,
  zeroAgentsMainContract,
  type ZeroAgentMetadataRequest,
  type ZeroAgentRequest,
  type ZeroAgentResponse,
} from "@vm0/api-contracts/contracts/zero-agents";
import { zeroOrgContract } from "@vm0/api-contracts/contracts/zero-org";
import { zeroUserPreferencesContract } from "@vm0/api-contracts/contracts/zero-user-preferences";

import { setupAppWithRoutes } from "../../../../__tests__/test-app";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { now } from "../../../../lib/time";
import { signSandboxJwtForTests } from "../../../auth/tokens";
import { authMeRoutes } from "../../auth-me";
import { zeroAgentsRoutes } from "../../zero-agents";
import { zeroOnboardingCompleteRoutes } from "../../zero-onboarding-complete";
import { zeroOnboardingStatusRoutes } from "../../zero-onboarding-status";
import { zeroOrgReadRoutes } from "../../zero-org-read";
import { zeroUserPreferencesRoutes } from "../../zero-user-preferences";
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

export interface OnboardingBootstrapOptions {
  readonly displayName: string;
  readonly sound?: string;
  readonly avatarUrl?: string;
  readonly timezone?: string;
}

function authHeaders(user: ApiTestUser | null): AuthHeaders {
  return user ? { authorization: "Bearer clerk-session" } : {};
}

function zeroAgentReadHeaders(user: ApiTestUser): AuthHeaders {
  if (!user.orgId) {
    throw new Error("Cannot bootstrap onboarding without an organization");
  }
  const seconds = Math.floor(now() / 1000);
  const token = signSandboxJwtForTests({
    scope: "zero",
    userId: user.userId,
    orgId: user.orgId,
    runId: `run_${randomUUID()}`,
    capabilities: ["agent:read"],
    iat: seconds,
    exp: seconds + 60,
  });
  return { authorization: `Bearer ${token}` };
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
    return setupAppWithRoutes({ context, routes: authMeRoutes })(authContract);
  }

  function onboardingStatusClient() {
    return setupAppWithRoutes({
      context,
      routes: zeroOnboardingStatusRoutes,
    })(onboardingStatusContract);
  }

  function onboardingCompleteClient() {
    return setupAppWithRoutes({
      context,
      routes: zeroOnboardingCompleteRoutes,
    })(onboardingCompleteContract);
  }

  function orgClient() {
    return setupAppWithRoutes({
      context,
      routes: zeroOrgReadRoutes,
    })(zeroOrgContract);
  }

  function userPreferencesClient() {
    return setupAppWithRoutes({
      context,
      routes: zeroUserPreferencesRoutes,
    })(zeroUserPreferencesContract);
  }

  function agentsClient() {
    return setupAppWithRoutes({
      context,
      routes: zeroAgentsRoutes,
    })(zeroAgentsMainContract);
  }

  function agentsByIdClient() {
    return setupAppWithRoutes({
      context,
      routes: zeroAgentsRoutes,
    })(zeroAgentsByIdContract);
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
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: nextUser.orgId
        ? [
            {
              role: nextUser.orgRole ?? "org:admin",
              organization: { id: nextUser.orgId },
              publicUserData: { userId: nextUser.userId },
            },
          ]
        : [],
    });
    return authHeaders(nextUser);
  }

  function acceptAgentStorageWrites(): void {
    context.mocks.s3.send.mockResolvedValue({ ContentLength: 1024 });
    context.mocks.s3.getSignedUrl.mockResolvedValue(
      "https://r2.example.com/storage/archive.tar.gz?sig=bdd",
    );
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

    async completeOnboarding(nextUser: ApiTestUser) {
      return await accept(
        onboardingCompleteClient().complete({
          headers: authenticate(nextUser),
          body: {},
        }),
        [200, 403],
      );
    },

    async bootstrapOnboarding(
      nextUser: ApiTestUser,
      options: OnboardingBootstrapOptions,
    ): Promise<string> {
      const headers = authenticate(nextUser);
      await accept(
        agentsClient().list({ headers: zeroAgentReadHeaders(nextUser) }),
        [200],
      );
      const statusResponse = await accept(
        onboardingStatusClient().getStatus({
          headers,
        }),
        [200],
      );
      const status = statusResponse.body;
      if (!status.defaultAgentId) {
        throw new Error("Expected onboarding bootstrap to create an agent");
      }

      await accept(
        agentsByIdClient().updateMetadata({
          params: { id: status.defaultAgentId },
          headers,
          body: {
            displayName: options.displayName,
            ...(options.sound === undefined ? {} : { sound: options.sound }),
            ...(options.avatarUrl === undefined
              ? {}
              : { avatarUrl: options.avatarUrl }),
          },
        }),
        [200],
      );

      if (options.timezone !== undefined) {
        await accept(
          userPreferencesClient().update({
            headers,
            body: { timezone: options.timezone },
          }),
          [200],
        );
      }

      const completed = await accept(
        onboardingCompleteClient().complete({
          headers,
          body: {},
        }),
        [200, 403],
      );
      if (completed.status !== 200) {
        throw new Error(
          `Expected onboarding completion to succeed, got ${completed.status}`,
        );
      }

      return status.defaultAgentId;
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
