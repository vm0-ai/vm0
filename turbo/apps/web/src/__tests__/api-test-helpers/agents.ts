import { and, eq } from "drizzle-orm";
import type { FirewallPolicies } from "@vm0/core";
import { initServices } from "../../lib/init-services";
import {
  agentComposes,
  agentComposeVersions,
} from "../../db/schema/agent-compose";
import { agentRuns } from "../../db/schema/agent-run";
import { zeroAgents } from "../../db/schema/zero-agent";
import { agentSessions } from "../../db/schema/agent-session";
import {
  zeroAgentSessions,
  type StoredChatMessage,
} from "../../db/schema/zero-agent-session";
import { conversations } from "../../db/schema/conversation";
import { composeJobs } from "../../db/schema/compose-job";
import { hashFileContent } from "../../lib/infra/storage/content-hash";
import { POST as createComposeRoute } from "../../../app/api/agent/composes/route";
import { POST as upsertOrgModelProviderRoute } from "../../../app/api/zero/model-providers/route";
import { uniqueId } from "../test-helpers";
import {
  createTestRequest,
  createDefaultComposeConfig,
  type ComposeConfigOptions,
} from "./core";
import type { AgentComposeYaml } from "../../lib/infra/agent-compose/types";

/**
 * Create a test compose via API route handler.
 *
 * @param agentName - The agent name
 * @param options - Optional config options or overrides for the agent config
 * @returns The created compose with composeId and versionId
 */
export async function createTestCompose(
  agentName: string,
  options?: ComposeConfigOptions | Partial<AgentComposeYaml["agents"][string]>,
): Promise<{
  composeId: string;
  versionId: string;
  name: string;
  agentId: string;
}> {
  const config = createDefaultComposeConfig(agentName, options);
  const request = createTestRequest(
    "http://localhost:3000/api/agent/composes",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: config }),
    },
  );
  const response = await createComposeRoute(request);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(
      `Failed to create compose: ${error.error?.message || response.status}`,
    );
  }
  const result: { composeId: string; versionId: string; name: string } =
    await response.json();

  // Ensure a matching zero_agents row exists (id = composeId after PK refactor)
  initServices();
  const [compose] = await globalThis.services.db
    .select({ orgId: agentComposes.orgId, userId: agentComposes.userId })
    .from(agentComposes)
    .where(eq(agentComposes.id, result.composeId))
    .limit(1);
  if (compose) {
    await globalThis.services.db
      .insert(zeroAgents)
      .values({
        id: result.composeId,
        orgId: compose.orgId,
        owner: compose.userId,
        name: result.name,
      })
      .onConflictDoNothing();
  }

  return { ...result, agentId: result.composeId };
}

/**
 * Create or update a test zero_agents row for agent metadata.
 *
 * Since zero_agents.id = agent_composes.id (composeId), this looks up
 * the composeId by (orgId, name) and upserts the metadata row.
 *
 * @param orgId - The org ID
 * @param name - The agent name (must match compose name)
 * @param metadata - Agent metadata fields
 */
export async function createTestZeroAgent(
  orgId: string,
  name: string,
  metadata: {
    displayName?: string;
    description?: string;
    sound?: string;
    permissionPolicies?: FirewallPolicies;
  },
): Promise<void> {
  initServices();

  // Resolve composeId and userId from compose table (zero_agents.id = composeId)
  const [compose] = await globalThis.services.db
    .select({ id: agentComposes.id, userId: agentComposes.userId })
    .from(agentComposes)
    .where(and(eq(agentComposes.orgId, orgId), eq(agentComposes.name, name)))
    .limit(1);

  if (!compose) {
    throw new Error(`Compose not found for org=${orgId} name=${name}`);
  }

  await globalThis.services.db
    .insert(zeroAgents)
    .values({
      id: compose.id,
      orgId,
      owner: compose.userId,
      name,
      displayName: metadata.displayName ?? null,
      description: metadata.description ?? null,
      sound: metadata.sound ?? null,
      permissionPolicies: metadata.permissionPolicies ?? null,
    })
    .onConflictDoUpdate({
      target: [zeroAgents.orgId, zeroAgents.name],
      set: {
        displayName: metadata.displayName ?? null,
        description: metadata.description ?? null,
        sound: metadata.sound ?? null,
        permissionPolicies: metadata.permissionPolicies ?? null,
      },
    });
}

/**
 * Get the zero_agents UUID by org + agent name.
 *
 * @param orgId - The org ID
 * @param name - The agent name
 * @returns The zero agent UUID
 */
export async function getTestZeroAgentId(
  orgId: string,
  name: string,
): Promise<string> {
  initServices();
  const [row] = await globalThis.services.db
    .select({ id: zeroAgents.id })
    .from(zeroAgents)
    .where(and(eq(zeroAgents.orgId, orgId), eq(zeroAgents.name, name)))
    .limit(1);
  if (!row) {
    throw new Error(`Zero agent not found: org=${orgId} name=${name}`);
  }
  return row.id;
}

/**
 * Read a zero_agents row by org + agent name.
 *
 * @param orgId - The org ID
 * @param name - The agent name
 * @returns The zero_agents row, or undefined if not found
 */
export async function getTestZeroAgent(
  orgId: string,
  name: string,
): Promise<
  | {
      displayName: string | null;
      description: string | null;
      sound: string | null;
    }
  | undefined
> {
  initServices();
  const [row] = await globalThis.services.db
    .select({
      displayName: zeroAgents.displayName,
      description: zeroAgents.description,
      sound: zeroAgents.sound,
    })
    .from(zeroAgents)
    .where(and(eq(zeroAgents.orgId, orgId), eq(zeroAgents.name, name)))
    .limit(1);
  return row;
}

/**
 * Create a test org-level model provider via API route handler.
 * This creates an org-scoped provider (using ORG_SENTINEL_USER_ID internally).
 *
 * @param type - The provider type
 * @param secretValue - The secret value
 * @param selectedModel - Optional selected model for providers with model selection
 * @returns The created provider with id and type
 */
export async function createTestOrgModelProvider(
  type: string,
  secretValue: string,
  selectedModel?: string,
): Promise<{ id: string; type: string; selectedModel: string | null }> {
  const request = createTestRequest(
    "http://localhost:3000/api/zero/model-providers",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type,
        secret: secretValue,
        selectedModel,
      }),
    },
  );
  const response = await upsertOrgModelProviderRoute(request);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(
      `Failed to create org model provider: ${error.error?.message || response.status}`,
    );
  }
  const data = await response.json();
  return data.provider;
}

/**
 * Create a test org-level multi-auth model provider via API route handler.
 * This creates an org-scoped provider (using ORG_SENTINEL_USER_ID internally).
 *
 * @param type - The provider type (e.g., "aws-bedrock")
 * @param authMethod - The auth method (e.g., "api-key", "access-keys")
 * @param secrets - Map of secret names to values
 * @param selectedModel - Optional selected model
 * @returns The created provider with id and type
 */
export async function createTestOrgMultiAuthModelProvider(
  type: string,
  authMethod: string,
  secrets: Record<string, string>,
  selectedModel?: string,
): Promise<{
  id: string;
  type: string;
  authMethod: string | null;
  secretNames: string[] | null;
  selectedModel: string | null;
}> {
  const request = createTestRequest(
    "http://localhost:3000/api/zero/model-providers",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type,
        authMethod,
        secrets,
        selectedModel,
      }),
    },
  );
  const response = await upsertOrgModelProviderRoute(request);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(
      `Failed to create org multi-auth model provider: ${error.error?.message || response.status}`,
    );
  }
  const data = await response.json();
  return data.provider;
}

/**
 * Create a test run via internal API route handler.
 *
 * @param userId - The user ID
 * @param agentComposeId - The compose ID
 */
export async function createTestAgentSession(
  userId: string,
  agentComposeId: string,
): Promise<{ id: string }> {
  const [compose] = await globalThis.services.db
    .select({ orgId: agentComposes.orgId })
    .from(agentComposes)
    .where(eq(agentComposes.id, agentComposeId))
    .limit(1);
  if (!compose) throw new Error(`Compose ${agentComposeId} not found`);
  const [session] = await globalThis.services.db
    .insert(agentSessions)
    .values({ userId, orgId: compose.orgId, agentComposeId })
    .returning({ id: agentSessions.id });
  return session!;
}

/**
 * Create a compose version for a compose.
 * Internal helper for createTestSessionWithConversation.
 */
export async function createTestComposeVersion(
  composeId: string,
  userId: string,
): Promise<string> {
  const versionId = uniqueId("version");
  await globalThis.services.db.insert(agentComposeVersions).values({
    id: versionId,
    composeId,
    content: { name: "test-agent", model: "claude-3-5-sonnet-20241022" },
    createdBy: userId,
  });
  // Update compose to point to this version
  await globalThis.services.db
    .update(agentComposes)
    .set({ headVersionId: versionId })
    .where(eq(agentComposes.id, composeId));
  return versionId;
}

/**
 * Create an agent session with a linked conversation.
 * This creates the full data chain required by validateAgentSession:
 * compose version -> run -> conversation -> session
 */
export async function createTestSessionWithConversation(
  userId: string,
  agentComposeId: string,
): Promise<{ id: string }> {
  // Look up orgId from the compose
  const [compose] = await globalThis.services.db
    .select({ orgId: agentComposes.orgId })
    .from(agentComposes)
    .where(eq(agentComposes.id, agentComposeId))
    .limit(1);
  if (!compose) {
    throw new Error(`Compose ${agentComposeId} not found`);
  }
  // Create compose version
  const versionId = await createTestComposeVersion(agentComposeId, userId);
  // Create run record
  const [run] = await globalThis.services.db
    .insert(agentRuns)
    .values({
      userId,
      orgId: compose.orgId,
      agentComposeVersionId: versionId,
      status: "completed",
      prompt: "test prompt",
    })
    .returning({
      id: agentRuns.id,
    });
  // Create conversation
  const [conversation] = await globalThis.services.db
    .insert(conversations)
    .values({
      runId: run!.id,
      cliAgentType: "claude",
      cliAgentSessionId: uniqueId("cli-session"),
      cliAgentSessionHistory: "[]",
    })
    .returning({ id: conversations.id });
  // Create session with conversation
  const [session] = await globalThis.services.db
    .insert(agentSessions)
    .values({
      userId,
      orgId: compose.orgId,
      agentComposeId,
      conversationId: conversation!.id,
    })
    .returning({ id: agentSessions.id });
  return session!;
}

/**
 * Insert an agent compose record directly in the database.
 *
 * Direct DB insert is required for schema-level tests (e.g., CASCADE behavior)
 * that need precise control over record creation without API side effects.
 */
export async function insertTestAgentCompose(
  userId: string,
  orgId: string,
  name: string,
) {
  const [row] = await globalThis.services.db
    .insert(agentComposes)
    .values({ userId, orgId, name })
    .returning();
  return row!;
}

/**
 * Insert a test compose with a version for export testing.
 *
 * Direct DB insert is required because the export test needs compose data
 * without going through the full compose creation API flow.
 */
export async function insertTestComposeWithVersion(
  userId: string,
  orgId: string,
  name: string,
  content: Record<string, unknown>,
) {
  const [compose] = await globalThis.services.db
    .insert(agentComposes)
    .values({ userId, orgId, name })
    .returning();

  const versionId = hashFileContent(Buffer.from(uniqueId("ver")));
  await globalThis.services.db.insert(agentComposeVersions).values({
    id: versionId,
    composeId: compose!.id,
    content,
    createdBy: userId,
  });

  await globalThis.services.db
    .update(agentComposes)
    .set({ headVersionId: versionId })
    .where(eq(agentComposes.id, compose!.id));

  return { composeId: compose!.id, versionId };
}

/**
 * Insert a test agent session with chat messages for export testing.
 *
 * Direct DB insert is required because agent sessions are created by
 * the run flow, not by a standalone API endpoint.
 */
export async function insertTestAgentSessionWithMessages(
  userId: string,
  agentComposeId: string,
  chatMessages: StoredChatMessage[],
) {
  const [compose] = await globalThis.services.db
    .select({ orgId: agentComposes.orgId })
    .from(agentComposes)
    .where(eq(agentComposes.id, agentComposeId))
    .limit(1);
  if (!compose) throw new Error(`Compose ${agentComposeId} not found`);
  const [session] = await globalThis.services.db
    .insert(agentSessions)
    .values({ userId, orgId: compose.orgId, agentComposeId })
    .returning({ id: agentSessions.id });
  await globalThis.services.db
    .insert(zeroAgentSessions)
    .values({ id: session!.id, chatMessages });
  return session!;
}

/**
 * Insert a test compose job directly in the database.
 */
export async function insertTestComposeJob(params: {
  userId: string;
  status?: string;
  githubUrl?: string;
}): Promise<{ id: string }> {
  const [row] = await globalThis.services.db
    .insert(composeJobs)
    .values({
      userId: params.userId,
      status: params.status ?? "completed",
      githubUrl: params.githubUrl ?? "https://github.com/test/repo",
    })
    .returning({ id: composeJobs.id });
  return row!;
}

/**
 * Delete a compose and its matching zero agent from the database.
 * Used to simulate a user deleting an agent compose.
 */
export async function deleteTestCompose(composeId: string): Promise<void> {
  initServices();
  // Resolve the compose's (orgId, name) to also delete the matching zero agent
  const [compose] = await globalThis.services.db
    .select({ orgId: agentComposes.orgId, name: agentComposes.name })
    .from(agentComposes)
    .where(eq(agentComposes.id, composeId))
    .limit(1);
  await globalThis.services.db
    .delete(agentComposes)
    .where(eq(agentComposes.id, composeId));
  if (compose) {
    await globalThis.services.db
      .delete(zeroAgents)
      .where(
        and(
          eq(zeroAgents.orgId, compose.orgId),
          eq(zeroAgents.name, compose.name),
        ),
      );
  }
}

/**
 * Clear the headVersionId of a compose to simulate a compose with no versions.
 * Useful for triggering pre-run failures in executeSchedule().
 */
export async function clearComposeHeadVersion(
  composeId: string,
): Promise<void> {
  await globalThis.services.db
    .update(agentComposes)
    .set({ headVersionId: null })
    .where(eq(agentComposes.id, composeId));
}

/**
 * Read the head compose version content for a compose record.
 * Returns the resolved compose content stored in the version.
 */
export async function getTestComposeVersionContent(
  composeId: string,
): Promise<Record<string, unknown> | null> {
  initServices();
  const [row] = await globalThis.services.db
    .select({
      content: agentComposeVersions.content,
    })
    .from(agentComposeVersions)
    .innerJoin(
      agentComposes,
      eq(agentComposes.headVersionId, agentComposeVersions.id),
    )
    .where(eq(agentComposes.id, composeId))
    .limit(1);
  return (row?.content as Record<string, unknown>) ?? null;
}

/**
 * Update agent compose's orgId. Useful when tests need telegram installations
 * or other compose-linked entities to belong to a specific org.
 */
export async function updateAgentComposeOrg(
  composeId: string,
  orgId: string,
): Promise<void> {
  await globalThis.services.db
    .update(agentComposes)
    .set({ orgId })
    .where(eq(agentComposes.id, composeId));
}

/**
 * Seed an agent compose record for testing.
 */
export async function seedTestCompose(opts: {
  userId: string;
  name: string;
  orgId: string;
}): Promise<{ composeId: string; agentId: string }> {
  initServices();
  const [row] = await globalThis.services.db
    .insert(agentComposes)
    .values({
      userId: opts.userId,
      name: opts.name,
      orgId: opts.orgId,
    })
    .returning({ id: agentComposes.id });
  if (!row) {
    throw new Error("Failed to seed agent compose");
  }

  // Ensure a matching zero_agents row exists (id = composeId after PK refactor)
  await globalThis.services.db
    .insert(zeroAgents)
    .values({
      id: row.id,
      orgId: opts.orgId,
      owner: opts.userId,
      name: opts.name,
    })
    .onConflictDoNothing();

  return { composeId: row.id, agentId: row.id };
}

/**
 * Seed an agent compose record WITHOUT a corresponding zero_agents row.
 * Useful for testing "agent not found" scenarios where the compose ID exists
 * in agent_composes (satisfying FK constraints) but getWorkspaceAgent() returns
 * undefined because there is no zero_agents row.
 */
export async function seedOrphanCompose(opts: {
  userId: string;
  name: string;
  orgId: string;
}): Promise<{ composeId: string }> {
  initServices();
  const [row] = await globalThis.services.db
    .insert(agentComposes)
    .values({
      userId: opts.userId,
      name: opts.name,
      orgId: opts.orgId,
    })
    .returning({ id: agentComposes.id });
  if (!row) {
    throw new Error("Failed to seed orphan agent compose");
  }
  return { composeId: row.id };
}

/**
 * Append chat messages to a zero_agent_sessions record.
 */
export async function appendTestChatMessages(
  sessionId: string,
  messages: StoredChatMessage[],
): Promise<void> {
  const [existing] = await globalThis.services.db
    .select({ chatMessages: zeroAgentSessions.chatMessages })
    .from(zeroAgentSessions)
    .where(eq(zeroAgentSessions.id, sessionId))
    .limit(1);

  const currentMessages = (existing?.chatMessages ?? []) as StoredChatMessage[];
  const updated = [...currentMessages, ...messages];

  await globalThis.services.db
    .insert(zeroAgentSessions)
    .values({ id: sessionId, chatMessages: updated })
    .onConflictDoUpdate({
      target: zeroAgentSessions.id,
      set: { chatMessages: updated },
    });
}

/**
 * Get chat messages for a zero_agent_sessions record.
 */
export async function getTestSessionChatMessages(
  sessionId: string,
): Promise<StoredChatMessage[]> {
  const [row] = await globalThis.services.db
    .select({ chatMessages: zeroAgentSessions.chatMessages })
    .from(zeroAgentSessions)
    .where(eq(zeroAgentSessions.id, sessionId))
    .limit(1);
  return (row?.chatMessages ?? []) as StoredChatMessage[];
}

/**
 * Get an agent session with its conversation data.
 */
export async function getTestAgentSessionWithConversation(
  sessionId: string,
): Promise<
  | {
      id: string;
      userId: string;
      orgId: string;
      agentComposeId: string;
      conversationId: string | null;
      memoryName: string | null;
      chatMessages: StoredChatMessage[];
    }
  | undefined
> {
  const [session] = await globalThis.services.db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);

  if (!session) return undefined;

  const [zeroSession] = await globalThis.services.db
    .select({ chatMessages: zeroAgentSessions.chatMessages })
    .from(zeroAgentSessions)
    .where(eq(zeroAgentSessions.id, sessionId))
    .limit(1);

  return {
    id: session.id,
    userId: session.userId,
    orgId: session.orgId,
    agentComposeId: session.agentComposeId,
    conversationId: session.conversationId ?? null,
    memoryName: session.memoryName ?? null,
    chatMessages: (zeroSession?.chatMessages ?? []) as StoredChatMessage[],
  };
}
