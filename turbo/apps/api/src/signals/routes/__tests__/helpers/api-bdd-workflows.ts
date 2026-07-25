import {
  chatThreadMessagesContract,
  chatThreadMetadataContract,
  type PagedChatMessage,
} from "@vm0/api-contracts/contracts/chat-threads";
import {
  zeroWorkflowsCollectionContract,
  zeroWorkflowAutomationsContract,
  type ZeroWorkflowAutomationSummary,
} from "@vm0/api-contracts/contracts/zero-workflows";
import { HttpResponse, http } from "msw";

import {
  accept,
  setupApp,
  type TestContext,
} from "../../../../__tests__/test-helpers";
import { mockEnv, mockOptionalEnv } from "../../../../lib/env";
import { server } from "../../../../mocks/server";
import { createBddApi, type ApiTestUser } from "./api-bdd";
import { createConnectorBddApi } from "./api-bdd-connectors";
import { createRunsApi } from "./api-bdd-runs";
import { createZeroRouteMocks } from "./zero-route-test";

const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const NOTION_OAUTH_TOKEN_URL = "https://api.notion.com/v1/oauth/token";

interface GoogleCalendarConnectorOAuthOptions {
  readonly accessToken?: string;
  readonly email?: string;
}

/**
 * Google Calendar connector OAuth provider boundary: env client credentials,
 * the shared Google token endpoint (authorization-code exchanges succeed),
 * and the Google userinfo endpoint the connector uses for identity.
 */
export function mockGoogleCalendarConnectorOAuth(
  options: GoogleCalendarConnectorOAuthOptions = {},
): void {
  mockEnv("VM0_WEB_URL", "https://www.vm0.ai");
  mockOptionalEnv("GOOGLE_OAUTH_CLIENT_ID", "google-client-id");
  mockOptionalEnv("GOOGLE_OAUTH_CLIENT_SECRET", "google-client-secret");

  server.use(
    http.post(GOOGLE_OAUTH_TOKEN_URL, async ({ request }) => {
      const body = new URLSearchParams(await request.text());
      if (body.get("grant_type") !== "authorization_code") {
        return HttpResponse.json(
          {
            error: "invalid_grant",
            error_description: "Refresh is not granted by this fixture",
          },
          { status: 400 },
        );
      }
      return HttpResponse.json({
        access_token: options.accessToken ?? "calendar-access-token",
        refresh_token: "calendar-refresh-token",
        expires_in: 3600,
        token_type: "Bearer",
        scope:
          "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/userinfo.email",
      });
    }),
    http.get(GOOGLE_USERINFO_URL, () => {
      return HttpResponse.json({
        id: "bdd-calendar-user-id",
        email: options.email ?? "calendar-user@example.com",
        name: "BDD Calendar User",
      });
    }),
  );
}

interface NotionConnectorOAuthOptions {
  readonly accessToken?: string;
}

/**
 * Notion connector OAuth provider boundary: env client credentials and the
 * Notion token endpoint, which embeds the workspace user identity in the
 * token response (no separate userinfo call).
 */
export function mockNotionConnectorOAuth(
  options: NotionConnectorOAuthOptions = {},
): void {
  mockEnv("VM0_WEB_URL", "https://www.vm0.ai");
  mockOptionalEnv("NOTION_OAUTH_CLIENT_ID", "notion-client-id");
  mockOptionalEnv("NOTION_OAUTH_CLIENT_SECRET", "notion-client-secret");

  server.use(
    http.post(NOTION_OAUTH_TOKEN_URL, () => {
      return HttpResponse.json({
        access_token: options.accessToken ?? "notion-access-token",
        refresh_token: "notion-refresh-token",
        expires_in: 3600,
        owner: {
          user: { id: "notion-user-1", name: "Notion User" },
        },
      });
    }),
  );
}

export function createWorkflowsBddApi(context: TestContext) {
  const bdd = createBddApi(context);
  const runs = createRunsApi(context);
  const connectors = createConnectorBddApi(context);
  const mocks = createZeroRouteMocks(context);

  function authHeaders() {
    return { authorization: "Bearer clerk-session" } as const;
  }

  function authenticate(actor: ApiTestUser) {
    mocks.clerk.session(actor.userId, actor.orgId, actor.orgRole);
    return authHeaders();
  }

  const api = {
    user: bdd.user,

    /**
     * Production Given for a workflow-owning org: billing entitlement through
     * the Stripe invoice webhook (which also completes onboarding) and an org
     * default model policy through the model-provider routes. The optional
     * timezone flows through the public user-preferences route.
     */
    async setupWorkflowOrg(
      options: {
        readonly timezone?: string;
        readonly tier?: "pro" | "team";
      } = {},
    ): Promise<{
      readonly actor: ApiTestUser;
      readonly customerId: string;
      readonly subscriptionId: string;
      readonly invoiceId: string;
    }> {
      const actor = bdd.user();
      if (options.timezone) {
        await bdd.bootstrapLimitedFreeOnboarding(actor, {
          displayName: "Workflow BDD Owner",
          timezone: options.timezone,
        });
      }
      const entitlement = await runs.grantProEntitlement(actor, {
        tier: options.tier,
      });
      await runs.ensureOrgModelProvider(actor);
      bdd.acceptAgentStorageWrites();
      return { actor, ...entitlement };
    },

    async createAgent(
      actor: ApiTestUser,
      options: {
        readonly displayName?: string;
        readonly visibility?: "public" | "private";
      } = {},
    ): Promise<{ readonly agentId: string }> {
      bdd.acceptAgentStorageWrites();
      const agent = await bdd.createAgent(actor, {
        displayName: options.displayName ?? "Workflow Automation Agent",
        ...(options.visibility ? { visibility: options.visibility } : {}),
      });
      return { agentId: agent.agentId };
    },

    async createWorkflow(
      actor: ApiTestUser,
      options: {
        readonly agentId: string;
        readonly name: string;
        readonly visibility?: "public" | "private";
      },
    ): Promise<string> {
      const client = setupApp({ context })(zeroWorkflowsCollectionContract);
      const response = await accept(
        client.create({
          headers: authenticate(actor),
          body: {
            agentId: options.agentId,
            name: options.name,
            visibility: options.visibility ?? "public",
          },
        }),
        [201],
      );
      return response.body.id;
    },

    async readAutomation(
      automationId: string,
    ): Promise<ZeroWorkflowAutomationSummary> {
      const client = setupApp({ context })(zeroWorkflowAutomationsContract);
      const response = await accept(
        client.get({ headers: authHeaders(), params: { id: automationId } }),
        [200],
      );
      return response.body;
    },

    async readThreadSelectedModel(threadId: string): Promise<string | null> {
      const client = setupApp({ context })(chatThreadMetadataContract);
      const response = await accept(
        client.get({ headers: authHeaders(), params: { id: threadId } }),
        [200],
      );
      return response.body.selectedModel;
    },

    async readThreadMessages(
      threadId: string,
    ): Promise<readonly PagedChatMessage[]> {
      const client = setupApp({ context })(chatThreadMessagesContract);
      const response = await accept(
        client.list({
          headers: authHeaders(),
          params: { threadId },
          query: {},
        }),
        [200],
      );
      return response.body.messages;
    },

    /**
     * Connects a connector through the public OAuth start + callback routes.
     * The matching provider boundary (mockGmailConnectorOAuth,
     * mockGoogleCalendarConnectorOAuth, mockNotionConnectorOAuth) must be
     * installed first.
     */
    async connectConnector(
      actor: ApiTestUser,
      type: "gmail" | "google-calendar" | "notion",
    ): Promise<void> {
      const start = await connectors.startOauth(actor, type, "oauth");
      const state = new URL(start.authorizationUrl).searchParams.get("state");
      if (!state) {
        throw new Error(`Expected ${type} OAuth start URL to include state`);
      }
      await connectors.completeOauthCallback(type, {
        code: `${type}-code`,
        state,
      });
    },
  };

  return api;
}
