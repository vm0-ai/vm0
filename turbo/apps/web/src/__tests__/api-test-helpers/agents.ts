import { updateChatThreadTitle } from "../../lib/zero/chat-thread";
import {
  createDefaultComposeConfig,
  getTestAuthContext,
  type ComposeConfigOptions,
} from "./core";
import type { AgentComposeYaml } from "../../lib/infra/agent-compose/types";
import {
  ensureZeroAgentRow,
  seedApiCompatibleCompose,
} from "../db-test-seeders/agents";

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
  deleteTestChatThread,
  insertTestChatMessage,
  getTestChatMessagesByThread,
  addTestRunToThread,
  insertTestAssistantEventMessages,
  setTestChatMessageAttachFiles,
  setTestChatMessageContent,
  setTestChatThreadLastReadAt,
  setTestChatThreadLastReadMessageId,
  setTestChatThreadModelPin,
  setTestChatThreadPinnedAt,
  setTestChatThreadRenamedAt,
  setTestChatThreadDraft,
} from "../db-test-seeders/agents";

export {
  getTestAgentSessionWithConversation,
  getTestAgentSessionArtifacts,
  getTestAgentComposeName,
  getTestChatThreadLastReadAt,
  getTestChatThreadLastReadMessageId,
  getTestChatThreadPinnedAt,
  getTestChatThreadRenamedAt,
  getTestUserMessageRunStorage,
} from "../db-test-assertions/agents";

// ---------------------------------------------------------------------------
// Production-compatible helpers.
//
// These call production route handlers or service entry points, not raw DB.
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
  const authContext = await getTestAuthContext();
  const result = await seedApiCompatibleCompose({
    userId: authContext.userId,
    orgId: authContext.orgId,
    content: config,
  });

  // Ensure a matching zero_agents row exists (id = composeId after PK refactor)
  await ensureZeroAgentRow(result.composeId);

  return { ...result, agentId: result.composeId };
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
