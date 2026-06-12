import type { z } from "zod";
import {
  cliAuthTestCodexOauthContract,
  cliAuthTestConnectorContract,
  cliAuthTestTokenContract,
} from "@vm0/api-contracts/contracts/cli-auth-test";
import { webhookFirewallAuthContract } from "@vm0/api-contracts/contracts/webhooks";
import { HttpResponse, http } from "msw";

import { createApp } from "../../../../app-factory";
import {
  accept,
  setupApp,
  type TestContext,
} from "../../../../__tests__/test-helpers";
import { server } from "../../../../mocks/server";
import { generateSandboxToken } from "../../../auth/tokens";
import type { ApiTestUser } from "./api-bdd";
import { encryptSecretForTests } from "./encrypt-secret";

type FirewallAuthBody = z.infer<
  (typeof webhookFirewallAuthContract.resolve)["body"]
>;
type SeedConnectorBody = z.infer<
  (typeof cliAuthTestConnectorContract.create)["body"]
>;
type SeedCodexOauthBody = z.infer<
  (typeof cliAuthTestCodexOauthContract.create)["body"]
>;

interface SandboxHeaders {
  readonly authorization: string;
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

function clerkUserProfile(actor: ApiTestUser): ClerkUserProfile {
  const emailId = `email_${actor.userId}`;
  return {
    id: actor.userId,
    emailAddresses: [{ id: emailId, emailAddress: actor.email }],
    primaryEmailAddressId: emailId,
    firstName: "BDD",
    lastName: "Firewall",
  };
}

function clerkMemberships(actor: ApiTestUser) {
  if (!actor.orgId) {
    return [];
  }

  return [
    {
      role: actor.orgRole ?? "org:admin",
      organization: {
        id: actor.orgId,
        slug: actor.orgId.toLowerCase(),
        name: "BDD Firewall Org",
      },
      publicUserData: { userId: actor.userId },
      createdAt: Date.parse("2026-01-01T00:00:00.000Z"),
    },
  ];
}

export function secretTemplate(name: string): string {
  return `\${{ secrets.${name} }}`;
}

export function varTemplate(name: string): string {
  return `\${{ vars.${name} }}`;
}

export function basicTemplate(first: string, second: string): string {
  return `\${{ basic(${first}, ${second}) }}`;
}

export function createFirewallApi(context: TestContext) {
  return {
    sandboxHeaders(
      actor: ApiTestUser,
      runId: string,
      tokenRunId?: string,
    ): SandboxHeaders {
      return {
        authorization: `Bearer ${generateSandboxToken(
          actor.userId,
          tokenRunId ?? runId,
          actor.orgId ?? "org_bdd_firewall",
        )}`,
      };
    },

    encryptedSecretsBody(values: Record<string, string>): string {
      return encryptSecretForTests(JSON.stringify(values));
    },

    seedClerkDirectory(actor: ApiTestUser): void {
      context.mocks.clerk.users.getUserList.mockResolvedValue({
        data: [clerkUserProfile(actor)],
      });
      const memberships = clerkMemberships(actor);
      context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue(
        { data: memberships },
      );
      context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
        { data: memberships },
      );
    },

    async provisionRunReadyOrg(actor: ApiTestUser): Promise<void> {
      this.seedClerkDirectory(actor);
      await accept(
        setupApp({ context })(cliAuthTestTokenContract).create({
          query: { email: actor.email },
          body: {},
        }),
        [200],
      );
    },

    async seedTestConnector(
      actor: ApiTestUser,
      body: SeedConnectorBody,
    ): Promise<void> {
      this.seedClerkDirectory(actor);
      await accept(
        setupApp({ context })(cliAuthTestConnectorContract).create({
          query: { email: actor.email },
          body,
        }),
        [200],
      );
    },

    async seedOrgCodexProvider(
      actor: ApiTestUser,
      body: SeedCodexOauthBody,
    ): Promise<void> {
      this.seedClerkDirectory(actor);
      await accept(
        setupApp({ context })(cliAuthTestCodexOauthContract).create({
          query: { email: actor.email },
          body,
        }),
        [200],
      );
    },

    async requestFirewallAuth(
      headers: SandboxHeaders | Record<string, never>,
      body: FirewallAuthBody,
      statuses: readonly (200 | 400 | 401 | 402 | 403 | 424 | 502)[],
    ) {
      return await accept(
        setupApp({ context })(webhookFirewallAuthContract).resolve({
          headers,
          body,
        }),
        statuses,
      );
    },

    async requestFirewallAuthRaw(
      body: string,
      headers: SandboxHeaders,
    ): Promise<{ status: number; body: unknown }> {
      const response = await createApp({ signal: context.signal }).request(
        "/api/webhooks/agent/firewall/auth",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...headers,
          },
          body,
        },
      );
      return { status: response.status, body: await response.json() };
    },

    mockTestOauthTokenRefresh(
      handler: () => Response | Promise<Response>,
    ): void {
      server.use(
        http.post("http://localhost:3000/api/test/oauth-provider/token", () => {
          return handler();
        }),
      );
    },

    mockCodexTokenRefresh(handler: () => Response | Promise<Response>): void {
      server.use(
        http.post("https://auth.openai.com/oauth/token", () => {
          return handler();
        }),
      );
    },

    oauthTokenResponse(args: {
      accessToken: string;
      refreshToken?: string;
      expiresIn?: number;
    }): Response {
      return HttpResponse.json({
        access_token: args.accessToken,
        ...(args.refreshToken ? { refresh_token: args.refreshToken } : {}),
        ...(args.expiresIn !== undefined ? { expires_in: args.expiresIn } : {}),
      });
    },
  };
}
