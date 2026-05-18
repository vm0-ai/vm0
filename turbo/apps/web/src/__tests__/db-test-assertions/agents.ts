import { and, asc, eq, isNull } from "drizzle-orm";
import { initServices } from "../../lib/init-services";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { zeroAgents } from "@vm0/db/schema/zero-agent";

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
 * Get the zero_agents UUID by org + agent name.
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

// ---------------------------------------------------------------------------
// Session / conversation assertions (migrated from api-test-helpers/agents.ts)
// ---------------------------------------------------------------------------

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
    }
  | undefined
> {
  initServices();
  const [session] = await globalThis.services.db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);

  if (!session) return undefined;

  return {
    id: session.id,
    userId: session.userId,
    orgId: session.orgId,
    agentComposeId: session.agentComposeId,
    conversationId: session.conversationId ?? null,
  };
}

/**
 * Read the artifacts column of an agent_sessions row.
 */
export async function getTestAgentSessionArtifacts(
  sessionId: string,
): Promise<Array<{ name: string; version?: string; mountPath: string }>> {
  initServices();
  const [row] = await globalThis.services.db
    .select({ artifacts: agentSessions.artifacts })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  return row?.artifacts ?? [];
}

/**
 * Read the last_read_at value for a chat thread.
 *
 * @why-db-direct No API route exposes last_read_at directly. Tests that
 * need to assert the exact DB state after a mark-read call require
 * direct read access.
 */
export async function getTestChatThreadLastReadAt(
  threadId: string,
): Promise<Date | null | undefined> {
  initServices();
  const [row] = await globalThis.services.db
    .select({ lastReadAt: chatThreads.lastReadAt })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .limit(1);
  if (!row) return undefined;
  return row.lastReadAt;
}

/**
 * Read raw user-message run storage for append-only immutability assertions.
 *
 * @why-db-direct Public chat APIs hide revoked queued rows, while these tests
 * assert the append-only storage shape directly.
 */
export async function getTestUserMessageRunStorage(params: {
  threadId: string;
  content: string | null;
  runId?: string | null;
  revokesMessageId?: string | null;
}): Promise<
  | {
      messageId: string;
      messageRunId: string | null;
      revokesMessageId: string | null;
      interruptsRunId: string | null;
    }
  | undefined
> {
  initServices();
  const conditions = [
    eq(chatMessages.chatThreadId, params.threadId),
    eq(chatMessages.role, "user"),
    params.content === null
      ? isNull(chatMessages.content)
      : eq(chatMessages.content, params.content),
  ];
  if (params.runId !== undefined) {
    conditions.push(
      params.runId === null
        ? isNull(chatMessages.runId)
        : eq(chatMessages.runId, params.runId),
    );
  }
  if (params.revokesMessageId !== undefined) {
    conditions.push(
      params.revokesMessageId === null
        ? isNull(chatMessages.revokesMessageId)
        : eq(chatMessages.revokesMessageId, params.revokesMessageId),
    );
  }
  const [row] = await globalThis.services.db
    .select({
      messageId: chatMessages.id,
      messageRunId: chatMessages.runId,
      revokesMessageId: chatMessages.revokesMessageId,
      interruptsRunId: chatMessages.interruptsRunId,
    })
    .from(chatMessages)
    .where(and(...conditions))
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.sequenceNumber))
    .limit(1);
  return row;
}

/**
 * Read the pinned_at value for a chat thread.
 *
 * @why-db-direct The list endpoint exposes pinnedAt as ISO string, but
 * pin/unpin route tests need raw DB state to assert the column was
 * updated/cleared.
 */
export async function getTestChatThreadPinnedAt(
  threadId: string,
): Promise<Date | null | undefined> {
  initServices();
  const [row] = await globalThis.services.db
    .select({ pinnedAt: chatThreads.pinnedAt })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .limit(1);
  if (!row) return undefined;
  return row.pinnedAt;
}

/**
 * Read the renamed_at value for a chat thread.
 *
 * @why-db-direct The rename endpoint test needs raw DB state to assert the
 * column was set and reset.
 */
export async function getTestChatThreadRenamedAt(
  threadId: string,
): Promise<Date | null | undefined> {
  initServices();
  const [row] = await globalThis.services.db
    .select({ renamedAt: chatThreads.renamedAt })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .limit(1);
  if (!row) return undefined;
  return row.renamedAt;
}

/**
 * Read the last_read_message_id value for a chat thread.
 *
 * @why-db-direct No API route exposes last_read_message_id directly. Tests
 * that need to assert exact DB state after mark-read require direct access.
 */
export async function getTestChatThreadLastReadMessageId(
  threadId: string,
): Promise<string | null | undefined> {
  initServices();
  const [row] = await globalThis.services.db
    .select({ lastReadMessageId: chatThreads.lastReadMessageId })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .limit(1);
  if (!row) return undefined;
  return row.lastReadMessageId;
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
