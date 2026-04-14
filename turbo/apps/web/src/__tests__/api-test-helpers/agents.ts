import { eq } from "drizzle-orm";
import { chatThreads } from "../../db/schema/chat-thread";
import { initServices } from "../../lib/init-services";
import {
  addRunToThread,
  updateChatThreadTitle,
} from "../../lib/zero/chat-thread";
import { agentComposes } from "../../db/schema/agent-compose";
import { agentRuns } from "../../db/schema/agent-run";
import { zeroAgents } from "../../db/schema/zero-agent";
import { agentSessions } from "../../db/schema/agent-session";
import {
  zeroAgentSessions,
  type StoredChatMessage,
} from "../../db/schema/zero-agent-session";
import { conversations } from "../../db/schema/conversation";
import { POST as createComposeRoute } from "../../../app/api/agent/composes/route";
import { POST as upsertOrgModelProviderRoute } from "../../../app/api/zero/model-providers/route";
import { uniqueId } from "../test-helpers";
import {
  createTestRequest,
  createDefaultComposeConfig,
  type ComposeConfigOptions,
} from "./core";
import type { AgentComposeYaml } from "../../lib/infra/agent-compose/types";
import { createTestComposeVersion } from "../db-test-seeders/agents";

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

/**
 * Link a run to a chat thread for test setup.
 * Wraps addRunToThread from chat-thread-service.
 */
export async function addTestRunToThread(
  threadId: string,
  runId: string,
  userId: string,
): Promise<void> {
  return addRunToThread(threadId, runId, userId);
}

/**
 * Update the title of a chat thread for test setup.
 * Wraps updateChatThreadTitle from chat-thread-service.
 */
export async function updateTestChatThreadTitle(
  threadId: string,
  title: string,
): Promise<void> {
  return updateChatThreadTitle(threadId, title);
}

/**
 * Insert a chat thread directly in the database.
 * Returns the thread ID.
 */
export async function insertTestChatThread(
  userId: string,
  agentComposeId: string,
  title: string,
): Promise<string> {
  initServices();
  const [thread] = await globalThis.services.db
    .insert(chatThreads)
    .values({ userId, agentComposeId, title })
    .returning({ id: chatThreads.id });
  return thread!.id;
}

/**
 * Get the agent compose name by compose ID.
 */
export async function getTestAgentComposeName(
  composeId: string,
): Promise<string> {
  initServices();
  const [row] = await globalThis.services.db
    .select({ name: agentComposes.name })
    .from(agentComposes)
    .where(eq(agentComposes.id, composeId))
    .limit(1);
  return row!.name;
}
