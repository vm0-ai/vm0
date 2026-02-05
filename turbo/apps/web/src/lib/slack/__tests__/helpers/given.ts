/**
 * BDD "Given" Helpers - Setup helpers for Slack tests
 *
 * These helpers set up the preconditions for test scenarios.
 * They follow the "Given" step pattern in BDD tests.
 */
import { eq } from "drizzle-orm";
import { createHash } from "crypto";
import { initServices } from "../../../../lib/init-services";
import { slackInstallations } from "../../../../db/schema/slack-installation";
import { slackUserLinks } from "../../../../db/schema/slack-user-link";
import { slackBindings } from "../../../../db/schema/slack-binding";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../db/schema/agent-compose";
import { scopes } from "../../../../db/schema/scope";
import { encryptCredentialValue } from "../../../../lib/crypto/secrets-encryption";
import { env } from "../../../../env";
import { uniqueId } from "../../../../__tests__/test-helpers";

// Note: encryptCredentialValue and env are still used for encrypting bot tokens

/**
 * Result from givenSlackWorkspaceInstalled
 */
export interface WorkspaceInstallationResult {
  installation: {
    id: string;
    slackWorkspaceId: string;
    botUserId: string;
    encryptedBotToken: string;
  };
}

/**
 * Result from givenLinkedSlackUser
 */
export interface LinkedUserResult extends WorkspaceInstallationResult {
  userLink: {
    id: string;
    slackUserId: string;
    slackWorkspaceId: string;
    vm0UserId: string;
  };
}

/**
 * Result from givenUserHasAgent
 */
export interface AgentBindingResult {
  binding: {
    id: string;
    agentName: string;
    composeId: string;
    description: string | null;
  };
  compose: {
    id: string;
    name: string;
  };
}

/**
 * Options for creating a Slack workspace installation
 */
export interface WorkspaceInstallationOptions {
  workspaceId?: string;
  workspaceName?: string;
  botUserId?: string;
}

/**
 * Options for creating a linked Slack user
 */
export interface LinkedUserOptions extends WorkspaceInstallationOptions {
  slackUserId?: string;
  vm0UserId?: string;
}

/**
 * Options for creating an agent binding
 */
export interface AgentBindingOptions {
  agentName?: string;
  description?: string | null;
  enabled?: boolean;
}

/**
 * Options for creating an agent binding with custom compose config
 */
export interface AgentBindingWithConfigOptions extends AgentBindingOptions {
  composeConfig: Record<string, unknown>;
}

/**
 * Given a Slack workspace has installed the VM0 app.
 * Creates a Slack installation record with encrypted bot token.
 */
export async function givenSlackWorkspaceInstalled(
  options: WorkspaceInstallationOptions = {},
): Promise<WorkspaceInstallationResult> {
  const {
    workspaceId = uniqueId("T"),
    workspaceName = "Test Workspace",
    botUserId = uniqueId("B"),
  } = options;

  initServices();
  const { SECRETS_ENCRYPTION_KEY } = env();

  const encryptedBotToken = encryptCredentialValue(
    "xoxb-test-bot-token",
    SECRETS_ENCRYPTION_KEY,
  );

  const [installation] = await globalThis.services.db
    .insert(slackInstallations)
    .values({
      slackWorkspaceId: workspaceId,
      slackWorkspaceName: workspaceName,
      encryptedBotToken,
      botUserId,
      installedBySlackUserId: uniqueId("U"),
    })
    .returning();

  if (!installation) {
    throw new Error("Failed to create Slack installation");
  }

  return {
    installation: {
      id: installation.id,
      slackWorkspaceId: installation.slackWorkspaceId,
      botUserId: installation.botUserId,
      encryptedBotToken: installation.encryptedBotToken,
    },
  };
}

/**
 * Given a Slack user has linked their account to VM0.
 * Creates both installation and user link records.
 */
export async function givenLinkedSlackUser(
  options: LinkedUserOptions = {},
): Promise<LinkedUserResult> {
  const {
    slackUserId = uniqueId("U"),
    vm0UserId = uniqueId("user"),
    ...installOptions
  } = options;

  const { installation } = await givenSlackWorkspaceInstalled(installOptions);

  initServices();

  const [userLink] = await globalThis.services.db
    .insert(slackUserLinks)
    .values({
      slackUserId,
      slackWorkspaceId: installation.slackWorkspaceId,
      vm0UserId,
    })
    .returning();

  if (!userLink) {
    throw new Error("Failed to create Slack user link");
  }

  return {
    installation,
    userLink: {
      id: userLink.id,
      slackUserId: userLink.slackUserId,
      slackWorkspaceId: userLink.slackWorkspaceId,
      vm0UserId: userLink.vm0UserId,
    },
  };
}

/**
 * Given a user has an agent configured.
 * Creates binding, compose, and version records.
 */
export async function givenUserHasAgent(
  userLinkId: string,
  options: AgentBindingOptions = {},
): Promise<AgentBindingResult> {
  const {
    agentName = uniqueId("agent"),
    description = null,
    enabled = true,
  } = options;

  initServices();

  // Get user link to find vm0UserId and workspaceId
  const [link] = await globalThis.services.db
    .select()
    .from(slackUserLinks)
    .where(eq(slackUserLinks.id, userLinkId))
    .limit(1);

  if (!link) {
    throw new Error(`Slack user link not found: ${userLinkId}`);
  }

  // Create scope
  const [scopeData] = await globalThis.services.db
    .insert(scopes)
    .values({
      slug: uniqueId("scope"),
      type: "personal",
      ownerId: link.vm0UserId,
    })
    .returning();

  if (!scopeData) {
    throw new Error("Failed to create scope");
  }

  // Create compose
  const [compose] = await globalThis.services.db
    .insert(agentComposes)
    .values({
      userId: link.vm0UserId,
      scopeId: scopeData.id,
      name: agentName,
    })
    .returning();

  if (!compose) {
    throw new Error("Failed to create agent compose");
  }

  // Create compose version with content-addressed ID
  // Use a proper AgentComposeYaml structure for the content
  const versionContent = {
    version: "1",
    agents: {
      [agentName]: {
        model: "claude-sonnet-4-20250514",
        prompt: "Test prompt for " + agentName,
      },
    },
  };
  // Generate unique version ID using compose.id for uniqueness across tests
  const versionId = createHash("sha256")
    .update(JSON.stringify({ ...versionContent, _composeId: compose.id }))
    .digest("hex");

  const [version] = await globalThis.services.db
    .insert(agentComposeVersions)
    .values({
      id: versionId,
      composeId: compose.id,
      content: versionContent,
      createdBy: link.vm0UserId,
    })
    .returning();

  if (!version) {
    throw new Error("Failed to create compose version");
  }

  // Update compose with head version
  await globalThis.services.db
    .update(agentComposes)
    .set({ headVersionId: version.id })
    .where(eq(agentComposes.id, compose.id));

  // Create binding
  const [binding] = await globalThis.services.db
    .insert(slackBindings)
    .values({
      slackUserLinkId: userLinkId,
      vm0UserId: link.vm0UserId,
      slackWorkspaceId: link.slackWorkspaceId,
      composeId: compose.id,
      agentName,
      description,
      enabled,
    })
    .returning();

  if (!binding) {
    throw new Error("Failed to create Slack binding");
  }

  return {
    binding: {
      id: binding.id,
      agentName: binding.agentName,
      composeId: binding.composeId,
      description: binding.description,
    },
    compose: {
      id: compose.id,
      name: compose.name,
    },
  };
}

/**
 * Given a user has multiple agents configured.
 * Creates multiple bindings for the user.
 */
export async function givenUserHasMultipleAgents(
  userLinkId: string,
  agents: Array<{ name: string; description?: string | null }>,
): Promise<AgentBindingResult[]> {
  const results: AgentBindingResult[] = [];

  for (const agent of agents) {
    const result = await givenUserHasAgent(userLinkId, {
      agentName: agent.name,
      description: agent.description ?? null,
    });
    results.push(result);
  }

  return results;
}

/**
 * Result from givenUserHasAgentWithConfig
 */
export interface AgentBindingWithConfigResult extends AgentBindingResult {
  scopeId: string;
}

/**
 * Given a user has an agent configured with custom compose config.
 * Creates binding, compose, and version records with the provided config.
 * This is useful for tests that need specific compose configuration like working_dir.
 */
export async function givenUserHasAgentWithConfig(
  userLinkId: string,
  options: AgentBindingWithConfigOptions,
): Promise<AgentBindingWithConfigResult> {
  const {
    agentName = uniqueId("agent"),
    description = null,
    enabled = true,
    composeConfig,
  } = options;

  initServices();

  // Get user link to find vm0UserId and workspaceId
  const [link] = await globalThis.services.db
    .select()
    .from(slackUserLinks)
    .where(eq(slackUserLinks.id, userLinkId))
    .limit(1);

  if (!link) {
    throw new Error(`Slack user link not found: ${userLinkId}`);
  }

  // Create scope
  const [scopeData] = await globalThis.services.db
    .insert(scopes)
    .values({
      slug: uniqueId("scope"),
      type: "personal",
      ownerId: link.vm0UserId,
    })
    .returning();

  if (!scopeData) {
    throw new Error("Failed to create scope");
  }

  // Create compose
  const [compose] = await globalThis.services.db
    .insert(agentComposes)
    .values({
      userId: link.vm0UserId,
      scopeId: scopeData.id,
      name: agentName,
    })
    .returning();

  if (!compose) {
    throw new Error("Failed to create agent compose");
  }

  // Create compose version with content-addressed ID using provided config
  const versionId = createHash("sha256")
    .update(JSON.stringify({ ...composeConfig, _composeId: compose.id }))
    .digest("hex");

  const [version] = await globalThis.services.db
    .insert(agentComposeVersions)
    .values({
      id: versionId,
      composeId: compose.id,
      content: composeConfig,
      createdBy: link.vm0UserId,
    })
    .returning();

  if (!version) {
    throw new Error("Failed to create compose version");
  }

  // Update compose with head version
  await globalThis.services.db
    .update(agentComposes)
    .set({ headVersionId: version.id })
    .where(eq(agentComposes.id, compose.id));

  // Create binding
  const [binding] = await globalThis.services.db
    .insert(slackBindings)
    .values({
      slackUserLinkId: userLinkId,
      vm0UserId: link.vm0UserId,
      slackWorkspaceId: link.slackWorkspaceId,
      composeId: compose.id,
      agentName,
      description,
      enabled,
    })
    .returning();

  if (!binding) {
    throw new Error("Failed to create Slack binding");
  }

  return {
    binding: {
      id: binding.id,
      agentName: binding.agentName,
      composeId: binding.composeId,
      description: binding.description,
    },
    compose: {
      id: compose.id,
      name: compose.name,
    },
    scopeId: scopeData.id,
  };
}
