import { updateChatThreadTitle } from "../../lib/zero/chat-thread";
import { POST as createComposeRoute } from "../../../app/api/agent/composes/route";
import { POST as upsertOrgModelProviderRoute } from "../../../app/api/zero/model-providers/route";
// eslint-disable-next-line web/no-direct-db-in-tests -- Personal-tier (BYOK) HTTP routes land in Wave 2 of Epic #11868; until then, user-tier seeders must call the service directly.
import {
  upsertUserModelProvider,
  upsertUserMultiAuthModelProvider,
} from "../../lib/zero/model-provider/model-provider-service";
import {
  createTestRequest,
  createDefaultComposeConfig,
  type ComposeConfigOptions,
} from "./core";
import type { AgentComposeYaml } from "../../lib/infra/agent-compose/types";
import type { ModelProviderType } from "@vm0/api-contracts/contracts/model-providers";
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
  setTestZeroAgentModelProvider,
  createTestAgentSession,
  createTestSessionWithConversation,
  insertTestChatThread,
  insertTestChatMessage,
  getTestChatMessagesByThread,
  addTestRunToThread,
  insertTestAssistantEventMessages,
  setTestChatMessageAttachFiles,
  setTestChatMessageContent,
  setTestChatThreadLastReadAt,
  setTestChatThreadLastReadMessageId,
  setTestChatThreadPinnedAt,
  setTestChatThreadRenamedAt,
  setTestChatThreadDraft,
} from "../db-test-seeders/agents";

export {
  getTestAgentSessionWithConversation,
  getTestAgentComposeName,
  getTestChatThreadLastReadAt,
  getTestChatThreadLastReadMessageId,
  getTestChatThreadPinnedAt,
  getTestChatThreadRenamedAt,
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

/**
 * Update the title of a chat thread for test setup.
 * Wraps updateChatThreadTitle from chat-thread-service.
 */
export async function updateTestChatThreadTitle(
  threadId: string,
  userId: string,
  title: string,
): Promise<void> {
  return updateChatThreadTitle(threadId, userId, title);
}

/**
 * Create a test user-level (BYOK) model provider via direct service call.
 *
 * The user-tier HTTP route lands in Wave 2 (#a3); this helper lets
 * service-layer tests exercise user-tier behavior in the meantime by
 * calling `upsertUserModelProvider` directly.
 */
export async function createTestUserModelProvider(
  orgId: string,
  userId: string,
  type: ModelProviderType,
  secretValue: string,
  selectedModel?: string,
): Promise<{
  id: string;
  type: string;
  isDefault: boolean;
  selectedModel: string | null;
}> {
  const result = await upsertUserModelProvider(
    orgId,
    userId,
    type,
    secretValue,
    selectedModel,
  );
  return {
    id: result.provider.id,
    type: result.provider.type,
    isDefault: result.provider.isDefault,
    selectedModel: result.provider.selectedModel,
  };
}

/**
 * Create a test user-level multi-auth model provider via direct service call.
 *
 * Mirrors `createTestUserModelProvider` for multi-auth providers (e.g.,
 * aws-bedrock).
 */
export async function createTestUserMultiAuthModelProvider(
  orgId: string,
  userId: string,
  type: ModelProviderType,
  authMethod: string,
  secretValues: Record<string, string>,
  selectedModel?: string,
): Promise<{
  id: string;
  type: string;
  authMethod: string | null;
  secretNames: string[] | null;
  isDefault: boolean;
  selectedModel: string | null;
}> {
  const result = await upsertUserMultiAuthModelProvider(
    orgId,
    userId,
    type,
    authMethod,
    secretValues,
    selectedModel,
  );
  return {
    id: result.provider.id,
    type: result.provider.type,
    authMethod: result.provider.authMethod ?? null,
    secretNames: result.provider.secretNames ?? null,
    isDefault: result.provider.isDefault,
    selectedModel: result.provider.selectedModel,
  };
}
