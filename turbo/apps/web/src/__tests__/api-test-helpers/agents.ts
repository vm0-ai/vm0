import { updateChatThreadTitle } from "../../lib/zero/chat-thread";
// eslint-disable-next-line web/no-direct-db-in-tests -- Test helper: service access needed for test data setup
import {
  insertChatMessage,
  getMessagesByThreadId,
} from "../../lib/zero/chat-thread/chat-message-service";
import { POST as createComposeRoute } from "../../../app/api/agent/composes/route";
import { POST as upsertOrgModelProviderRoute } from "../../../app/api/zero/model-providers/route";
import {
  createTestRequest,
  createDefaultComposeConfig,
  type ComposeConfigOptions,
} from "./core";
import type { AgentComposeYaml } from "../../lib/infra/agent-compose/types";
import { ensureZeroAgentRow } from "../db-test-seeders/agents";

// ---------------------------------------------------------------------------
// Re-exports: DB-direct seeders and assertion helpers.
//
// These functions were moved to dedicated directories but are re-exported
// here for backward compatibility — existing test files import from
// api-test-helpers and should continue to work unchanged.
// ---------------------------------------------------------------------------

export {
  createTestComposeVersion,
  ensureZeroAgentRow,
  createTestAgentSession,
  createTestSessionWithConversation,
  insertTestAgentSessionWithMessages,
  appendTestChatMessages,
  insertTestChatThread,
} from "../db-test-seeders/agents";

export {
  getTestSessionChatMessages,
  getTestAgentSessionWithConversation,
  getTestAgentComposeName,
} from "../db-test-assertions/agents";

// ---------------------------------------------------------------------------
// API-based helpers.
//
// These call production route handlers (not raw DB) and are valid
// API-based helpers.
// ---------------------------------------------------------------------------

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
  await ensureZeroAgentRow(result.composeId);

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

// ---------------------------------------------------------------------------
// Service wrappers.
//
// These wrap internal service functions and are valid API-level helpers.
// ---------------------------------------------------------------------------

/**
 * Link a run to a chat thread by inserting chat messages (user + assistant placeholder).
 */
export async function addTestRunToThread(
  threadId: string,
  runId: string,
  _userId: string,
  prompt?: string,
): Promise<void> {
  await insertChatMessage({
    chatThreadId: threadId,
    role: "user",
    content: prompt ?? "test prompt",
    runId: null,
  });
  await insertChatMessage({
    chatThreadId: threadId,
    role: "assistant",
    content: null,
    runId,
  });
}

/**
 * Get chat messages for a thread from the chat_messages table.
 */
export async function getTestChatMessagesByThread(
  threadId: string,
): Promise<Awaited<ReturnType<typeof getMessagesByThreadId>>> {
  return getMessagesByThreadId(threadId);
}

/**
 * Insert a chat message directly into the chat_messages table.
 */
export async function insertTestChatMessage(params: {
  chatThreadId: string;
  role: "user" | "assistant";
  content: string | null;
  runId?: string | null;
}): Promise<{ id: string; createdAt: Date }> {
  return insertChatMessage({
    chatThreadId: params.chatThreadId,
    role: params.role,
    content: params.content,
    runId: params.runId ?? null,
  });
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
