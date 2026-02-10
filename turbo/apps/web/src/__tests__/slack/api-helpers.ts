/**
 * API-based Slack Test Helpers
 *
 * These helpers create Slack test fixtures through HTTP endpoints instead of
 * direct database operations, following web testing principles.
 *
 * External APIs (Slack OAuth, Slack Web API) are mocked via vi.mock("@slack/web-api")
 * in setup.ts — all `new WebClient()` calls return the same singleton mock object.
 */
import crypto from "crypto";
import { vi } from "vitest";
import { WebClient } from "@slack/web-api";
import { mockClerk } from "../clerk-mock";
import { createTestCompose } from "../api-test-helpers";
import { uniqueId } from "../test-helpers";
import { env } from "../../env";
import { initServices } from "../../lib/init-services";

// Import route handlers
import { GET as oauthCallbackRoute } from "../../../app/api/slack/oauth/callback/route";
import { POST as interactiveRoute } from "../../../app/api/slack/interactive/route";

// Import server action
import { linkSlackAccount } from "../../../app/slack/link/actions";

// Import API helpers
import { createTestScope } from "../api-test-helpers";

/**
 * Extract binding ID from a published App Home view by finding the Unlink button
 * for a given agent name (the button value contains the binding UUID).
 */
function extractBindingIdFromView(
  publishedView: Record<string, unknown> | undefined,
  agentName: string,
): string {
  if (!publishedView) {
    throw new Error("No App Home view was published during agent setup");
  }

  const view = publishedView.view as
    | { blocks?: Array<Record<string, unknown>> }
    | undefined;
  const blocks = view?.blocks ?? [];

  // Find the actions block that follows the agent's section block
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    if (
      block.type === "section" &&
      typeof block.text === "object" &&
      block.text !== null &&
      "text" in block.text &&
      typeof block.text.text === "string" &&
      block.text.text.includes(agentName)
    ) {
      // Next block should be actions with Update/Unlink buttons
      const actionsBlock = blocks[i + 1];
      if (actionsBlock?.type === "actions") {
        const elements = actionsBlock.elements as Array<{
          action_id: string;
          value?: string;
        }>;
        const unlinkButton = elements?.find(
          (el) => el.action_id === "home_agent_unlink",
        );
        if (unlinkButton?.value) {
          return unlinkButton.value;
        }
      }
    }
  }

  throw new Error(
    `Could not find binding ID for agent "${agentName}" in published App Home view`,
  );
}

/**
 * Result from givenSlackWorkspaceInstalled
 */
interface WorkspaceInstallationResult {
  installation: {
    slackWorkspaceId: string;
    slackWorkspaceName: string;
    botUserId: string;
  };
}

/**
 * Result from givenLinkedSlackUser
 */
interface LinkedUserResult extends WorkspaceInstallationResult {
  userLink: {
    slackUserId: string;
    slackWorkspaceId: string;
    vm0UserId: string;
    scopeId: string;
  };
}

/**
 * Result from givenUserHasAgent
 */
interface AgentBindingResult {
  binding: {
    id: string;
    agentName: string;
    composeId: string;
  };
  compose: {
    id: string;
    name: string;
  };
}

/**
 * Options for creating a Slack workspace installation
 */
interface WorkspaceInstallationOptions {
  workspaceId?: string;
  workspaceName?: string;
  botUserId?: string;
}

/**
 * Options for creating a linked Slack user
 */
interface LinkedUserOptions extends WorkspaceInstallationOptions {
  slackUserId?: string;
  vm0UserId?: string;
}

/**
 * Options for creating an agent binding
 */
interface AgentBindingOptions {
  agentName?: string;
}

/**
 * Given a Slack workspace has installed the VM0 app.
 * Creates installation via OAuth callback endpoint.
 */
export async function givenSlackWorkspaceInstalled(
  options: WorkspaceInstallationOptions = {},
): Promise<WorkspaceInstallationResult> {
  const workspaceId = options.workspaceId ?? uniqueId("T");
  const workspaceName = options.workspaceName ?? "Test Workspace";
  const botUserId = options.botUserId ?? uniqueId("B");
  const accessToken = `xoxb-test-${uniqueId("token")}`;

  // Configure the WebClient singleton's oauth.v2.access to return expected values
  const mockClient = vi.mocked(new WebClient(), true);
  mockClient.oauth.v2.access.mockResolvedValueOnce({
    ok: true,
    access_token: accessToken,
    bot_user_id: botUserId,
    team: { id: workspaceId, name: workspaceName },
  } as never);

  // Call OAuth callback endpoint with a mock code
  const callbackUrl = new URL("http://localhost/api/slack/oauth/callback");
  callbackUrl.searchParams.set("code", "mock-oauth-code");

  const request = new Request(callbackUrl.toString(), { method: "GET" });
  const response = await oauthCallbackRoute(request);

  // The callback redirects on success, so check for redirect status
  if (response.status !== 302 && response.status !== 307) {
    throw new Error(
      `OAuth callback failed with status ${response.status}: ${await response.text()}`,
    );
  }

  return {
    installation: {
      slackWorkspaceId: workspaceId,
      slackWorkspaceName: workspaceName,
      botUserId,
    },
  };
}

/**
 * Given a Slack user has linked their account to VM0.
 * Creates installation, user link, and scope via API endpoints.
 */
export async function givenLinkedSlackUser(
  options: LinkedUserOptions = {},
): Promise<LinkedUserResult> {
  const slackUserId = options.slackUserId ?? uniqueId("U");
  const vm0UserId = options.vm0UserId ?? uniqueId("user");

  // First install the workspace
  const { installation } = await givenSlackWorkspaceInstalled({
    workspaceId: options.workspaceId,
    workspaceName: options.workspaceName,
    botUserId: options.botUserId,
  });

  // Mock Clerk auth for the server action and scope creation
  mockClerk({ userId: vm0UserId });

  // Create scope for the user (required for compose creation)
  const scopeSlug = uniqueId("scope");
  const scopeData = await createTestScope(scopeSlug);

  // Call the server action to link the user
  const result = await linkSlackAccount(
    slackUserId,
    installation.slackWorkspaceId,
  );

  if (!result.success) {
    throw new Error(`Failed to link Slack user: ${result.error}`);
  }

  return {
    installation,
    userLink: {
      slackUserId,
      slackWorkspaceId: installation.slackWorkspaceId,
      vm0UserId,
      scopeId: scopeData.id,
    },
  };
}

/**
 * Create a signed Slack interactive request
 */
function createSlackInteractiveRequest(payload: object): Request {
  initServices();
  const { SLACK_SIGNING_SECRET } = env();
  if (!SLACK_SIGNING_SECRET) {
    throw new Error("SLACK_SIGNING_SECRET must be set in test environment");
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const payloadStr = JSON.stringify(payload);
  const body = `payload=${encodeURIComponent(payloadStr)}`;

  // Generate signature
  const baseString = `v0:${timestamp}:${body}`;
  const hmac = crypto.createHmac("sha256", SLACK_SIGNING_SECRET);
  const signature = `v0=${hmac.update(baseString).digest("hex")}`;

  return new Request("http://localhost/api/slack/interactive", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "x-slack-signature": signature,
      "x-slack-request-timestamp": timestamp,
    },
    body,
  });
}

/**
 * Given a user has an agent configured.
 * Creates agent via compose API and binding via interactive endpoint.
 */
export async function givenUserHasAgent(
  userLink: LinkedUserResult["userLink"],
  options: AgentBindingOptions = {},
): Promise<AgentBindingResult> {
  const agentName = options.agentName ?? uniqueId("agent");

  // Mock Clerk auth for compose creation
  mockClerk({ userId: userLink.vm0UserId });

  // Create agent compose via API
  const { composeId } = await createTestCompose(agentName);

  // Create binding via interactive endpoint (modal submission)
  const interactivePayload = {
    type: "view_submission",
    user: {
      id: userLink.slackUserId,
      username: "testuser",
      team_id: userLink.slackWorkspaceId,
    },
    team: {
      id: userLink.slackWorkspaceId,
      domain: "test-workspace",
    },
    view: {
      id: "view-123",
      callback_id: "agent_add_modal",
      state: {
        values: {
          agent_select: {
            agent_select_action: {
              type: "static_select",
              selected_option: { value: composeId },
            },
          },
        },
      },
      private_metadata: JSON.stringify({ channelId: "C123" }),
    },
  };

  // Clear views.publish mock so we can capture only the call from this route
  const mockClient = vi.mocked(new WebClient(), true);
  mockClient.views.publish.mockClear();

  const request = createSlackInteractiveRequest(interactivePayload);
  const response = await interactiveRoute(request);

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create agent binding: ${error}`);
  }

  // Extract binding ID from the published App Home view (captured by module mock)
  const publishCall = mockClient.views.publish.mock.lastCall?.[0] as
    | Record<string, unknown>
    | undefined;
  const bindingId = extractBindingIdFromView(
    publishCall,
    agentName.toLowerCase(),
  );

  return {
    binding: {
      id: bindingId,
      agentName: agentName.toLowerCase(),
      composeId,
    },
    compose: {
      id: composeId,
      name: agentName,
    },
  };
}
