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
import { eq, and, sql } from "drizzle-orm";
import { mockClerk } from "../clerk-mock";
import { createTestCompose, createTestScope } from "../api-test-helpers";
import { uniqueId } from "../test-helpers";
import { initServices } from "../../lib/init-services";
import { slackUserLinks } from "../../db/schema/slack-user-link";
import { slackInstallations } from "../../db/schema/slack-installation";

// Import route handlers
import { GET as oauthCallbackRoute } from "../../../app/api/slack/oauth/callback/route";

// Import server action
import { linkSlackAccount } from "../../../app/slack/link/actions";

/**
 * Result from givenSlackWorkspaceInstalled
 */
interface WorkspaceInstallationResult {
  installation: {
    slackWorkspaceId: string;
    slackWorkspaceName: string;
    botUserId: string;
    defaultComposeId: string;
    adminSlackUserId: string;
  };
}

/**
 * Result from givenLinkedSlackUser
 */
interface LinkedUserResult extends WorkspaceInstallationResult {
  userLink: {
    id: string;
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
  adminUserId?: string;
  agentName?: string;
}

/**
 * Options for creating a linked Slack user
 */
interface LinkedUserOptions extends WorkspaceInstallationOptions {
  slackUserId?: string;
  vm0UserId?: string;
  isAdmin?: boolean;
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
  const adminSlackUserId = uniqueId("admin-slack");

  // Create admin user scope + compose for the workspace agent
  const adminUserId = options.adminUserId ?? uniqueId("admin");
  mockClerk({ userId: adminUserId });
  await createTestScope(uniqueId("admin-scope"));
  const { composeId } = await createTestCompose(
    options.agentName ?? "default-agent",
  );

  // Configure the WebClient singleton's oauth.v2.access to return expected values
  const mockClient = vi.mocked(new WebClient(), true);
  mockClient.oauth.v2.access.mockResolvedValueOnce({
    ok: true,
    access_token: accessToken,
    bot_user_id: botUserId,
    team: { id: workspaceId, name: workspaceName },
    authed_user: { id: adminSlackUserId },
  } as never);

  // Call OAuth callback endpoint with a mock code and state containing composeId
  const callbackUrl = new URL("http://localhost/api/slack/oauth/callback");
  callbackUrl.searchParams.set("code", "mock-oauth-code");
  callbackUrl.searchParams.set("state", JSON.stringify({ composeId }));

  const request = new Request(callbackUrl.toString(), { method: "GET" });
  const response = await oauthCallbackRoute(request);

  // The callback redirects on success, so check for redirect status
  if (response.status !== 302 && response.status !== 307) {
    const text = await response.text();
    throw new Error(
      `OAuth callback failed with status ${response.status}: ${text}`,
    );
  }

  return {
    installation: {
      slackWorkspaceId: workspaceId,
      slackWorkspaceName: workspaceName,
      botUserId,
      defaultComposeId: composeId,
      adminSlackUserId,
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
  const vm0UserId = options.vm0UserId ?? uniqueId("user");

  // First install the workspace
  const { installation } = await givenSlackWorkspaceInstalled({
    workspaceId: options.workspaceId,
    workspaceName: options.workspaceName,
    botUserId: options.botUserId,
  });

  // If isAdmin, use the installation's admin Slack user ID so the link matches
  const slackUserId = options.isAdmin
    ? installation.adminSlackUserId
    : (options.slackUserId ?? uniqueId("U"));

  // Restore Clerk mock to the linking user (givenSlackWorkspaceInstalled sets it to admin)
  mockClerk({ userId: vm0UserId });

  // Create scope for the user (required for compose creation)
  const scopeSlug = uniqueId("scope");
  const scopeData = await createTestScope(scopeSlug);

  // WebClient methods (views.publish, chat.postEphemeral) are already mocked in setup.ts
  // so linking triggers (refreshAppHome, postEphemeral) will use those mocks.

  // Call the server action to link the user
  const result = await linkSlackAccount(
    slackUserId,
    installation.slackWorkspaceId,
  );

  if (!result.success) {
    throw new Error(`Failed to link Slack user: ${result.error}`);
  }

  // Query the created user link to get the id
  initServices();
  const [link] = await globalThis.services.db
    .select({ id: slackUserLinks.id })
    .from(slackUserLinks)
    .where(
      and(
        eq(slackUserLinks.slackUserId, slackUserId),
        eq(slackUserLinks.slackWorkspaceId, installation.slackWorkspaceId),
      ),
    )
    .limit(1);

  return {
    installation,
    userLink: {
      id: link!.id,
      slackUserId,
      slackWorkspaceId: installation.slackWorkspaceId,
      vm0UserId,
      scopeId: scopeData.id,
    },
  };
}

/**
 * Given the workspace has an agent configured.
 * Creates agent compose and sets it as the workspace default.
 * In the new model, there are no per-user bindings - the workspace has a single
 * default agent set by the admin.
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

  // Update the workspace's default agent
  initServices();
  await globalThis.services.db
    .update(slackInstallations)
    .set({ defaultComposeId: composeId })
    .where(eq(slackInstallations.slackWorkspaceId, userLink.slackWorkspaceId));

  return {
    binding: {
      id: composeId,
      agentName: agentName.toLowerCase(),
      composeId,
    },
    compose: {
      id: composeId,
      name: agentName,
    },
  };
}

/**
 * Given the workspace agent has been removed (compose no longer exists).
 * Points defaultComposeId to a non-existent UUID so getWorkspaceAgent
 * naturally returns undefined. Uses session_replication_role to bypass
 * the FK constraint (this is a test-only technique).
 */
export async function givenWorkspaceAgentUnavailable(
  slackWorkspaceId: string,
): Promise<void> {
  initServices();
  const nonExistentId = crypto.randomUUID();
  await globalThis.services.db.execute(
    sql`SET session_replication_role = 'replica'`,
  );
  await globalThis.services.db
    .update(slackInstallations)
    .set({ defaultComposeId: nonExistentId })
    .where(eq(slackInstallations.slackWorkspaceId, slackWorkspaceId));
  await globalThis.services.db.execute(
    sql`SET session_replication_role = 'origin'`,
  );
}
