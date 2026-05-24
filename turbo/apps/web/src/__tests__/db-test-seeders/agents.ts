import { and, eq, sql } from "drizzle-orm";
import { initServices } from "../../lib/init-services";
import { computeComposeVersionId } from "../../lib/infra/agent-compose/content-hash";
import type { AgentComposeYaml } from "../../lib/infra/agent-compose/types";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { conversations } from "@vm0/db/schema/conversation";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { uniqueId } from "../test-helpers";
import { getMessagesByThreadId } from "../../lib/zero/chat-thread/chat-message-service";

/**
 * @why-db-direct Seeds the compose create-route side effects after the legacy
 * web route has been removed. Tests still need production-compatible compose
 * rows without making network calls through the web-to-api rewrite.
 */
export async function seedApiCompatibleCompose(opts: {
  userId: string;
  orgId: string;
  content: AgentComposeYaml;
}): Promise<{ composeId: string; versionId: string; name: string }> {
  initServices();

  const agentNames = Object.keys(opts.content.agents);
  if (agentNames.length !== 1) {
    throw new Error("seedApiCompatibleCompose expects exactly one agent");
  }

  const agentName = agentNames[0];
  if (!agentName) {
    throw new Error("seedApiCompatibleCompose expects an agent name");
  }

  const agent = opts.content.agents[agentName];
  if (!agent) {
    throw new Error(`seedApiCompatibleCompose missing agent ${agentName}`);
  }

  const normalizedAgentName = agentName.toLowerCase();
  const resolvedContent: AgentComposeYaml = {
    ...opts.content,
    agents: {
      [normalizedAgentName]: agent,
    },
  };
  const versionId = computeComposeVersionId(resolvedContent);
  const db = globalThis.services.db;

  const [existingCompose] = await db
    .select({ id: agentComposes.id })
    .from(agentComposes)
    .where(
      and(
        eq(agentComposes.orgId, opts.orgId),
        eq(agentComposes.name, normalizedAgentName),
      ),
    )
    .limit(1);

  let composeId = existingCompose?.id;
  if (!composeId) {
    const [created] = await db
      .insert(agentComposes)
      .values({
        userId: opts.userId,
        orgId: opts.orgId,
        name: normalizedAgentName,
      })
      .returning({ id: agentComposes.id });
    if (!created) {
      throw new Error("Failed to seed agent compose");
    }
    composeId = created.id;
  }

  const [existingVersion] = await db
    .select({ id: agentComposeVersions.id })
    .from(agentComposeVersions)
    .where(eq(agentComposeVersions.id, versionId))
    .limit(1);

  if (!existingVersion) {
    await db.insert(agentComposeVersions).values({
      id: versionId,
      composeId,
      content: resolvedContent,
      createdBy: opts.userId,
    });
  }

  await db
    .update(agentComposes)
    .set({ headVersionId: versionId, updatedAt: new Date() })
    .where(eq(agentComposes.id, composeId));

  return { composeId, versionId, name: normalizedAgentName };
}

/**
 * @why-db-direct Creates version with arbitrary non-content-hashed ID —
 * API uses content-addressed versioning. Internal helper for session creation.
 */
export async function createTestComposeVersion(
  composeId: string,
  userId: string,
): Promise<string> {
  initServices();
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

// ---------------------------------------------------------------------------
// Session / conversation seeders (migrated from api-test-helpers/agents.ts)
// ---------------------------------------------------------------------------

/**
 * Seed retired zero_agents model fields directly. Used by tests that verify
 * model-first routing ignores legacy agent-level model settings.
 *
 * @why-db-direct These fields no longer have a public write path; tests need a
 * direct setter to cover stale persisted data.
 */
export async function setTestZeroAgentModelProvider(
  agentId: string,
  modelProviderId: string | null,
  selectedModel: string | null,
): Promise<void> {
  initServices();
  await globalThis.services.db
    .update(zeroAgents)
    .set({ modelProviderId, selectedModel })
    .where(eq(zeroAgents.id, agentId));
}

/**
 * Ensure a matching zero_agents row exists for a compose.
 * Extracted from createTestCompose — the compose API route doesn't create
 * the zero_agents row; this bridges the gap for tests.
 *
 * @why-db-direct The compose creation API route does not insert a
 * zero_agents row. Tests need this row for agent lookups and session
 * creation.
 */
export async function ensureZeroAgentRow(composeId: string): Promise<void> {
  initServices();
  const [compose] = await globalThis.services.db
    .select({
      orgId: agentComposes.orgId,
      userId: agentComposes.userId,
      name: agentComposes.name,
    })
    .from(agentComposes)
    .where(eq(agentComposes.id, composeId))
    .limit(1);
  if (!compose) return;
  await globalThis.services.db
    .insert(zeroAgents)
    .values({
      id: composeId,
      orgId: compose.orgId,
      owner: compose.userId,
      name: compose.name,
    })
    .onConflictDoNothing();
}

/**
 * Create a test agent session linked to a compose.
 *
 * @why-db-direct Agent sessions are created by the run flow, not a
 * standalone API endpoint. Tests need direct seeding for isolated setup.
 */
export async function createTestAgentSession(
  userId: string,
  agentComposeId: string,
): Promise<{ id: string }> {
  initServices();
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
 *
 * @why-db-direct Creates full compose→run→conversation→session chain;
 * no single API endpoint provides this setup.
 */
export async function createTestSessionWithConversation(
  userId: string,
  agentComposeId: string,
  existingVersionId?: string,
  cliAgentType: string = "claude",
): Promise<{ id: string }> {
  initServices();
  // Look up orgId from the compose
  const [compose] = await globalThis.services.db
    .select({ orgId: agentComposes.orgId })
    .from(agentComposes)
    .where(eq(agentComposes.id, agentComposeId))
    .limit(1);
  if (!compose) {
    throw new Error(`Compose ${agentComposeId} not found`);
  }
  // Use provided version or create a new one
  const versionId =
    existingVersionId ??
    (await createTestComposeVersion(agentComposeId, userId));
  // Create session first (without conversation) so the run's FK can point at it.
  const [session] = await globalThis.services.db
    .insert(agentSessions)
    .values({
      userId,
      orgId: compose.orgId,
      agentComposeId,
      conversationId: null,
    })
    .returning({ id: agentSessions.id });
  if (!session) {
    throw new Error("Failed to seed agent session");
  }
  // Create run record (session_id NOT NULL + FK → must reference an existing
  // agent_sessions row).
  const [run] = await globalThis.services.db
    .insert(agentRuns)
    .values({
      userId,
      orgId: compose.orgId,
      agentComposeVersionId: versionId,
      status: "completed",
      prompt: "test prompt",
      sessionId: session.id,
    })
    .returning({
      id: agentRuns.id,
    });
  // Create conversation
  const [conversation] = await globalThis.services.db
    .insert(conversations)
    .values({
      runId: run!.id,
      cliAgentType: cliAgentType,
      cliAgentSessionId: uniqueId("cli-session"),
      cliAgentSessionHistory: "[]",
    })
    .returning({ id: conversations.id });
  // Link the conversation back into the session so downstream lookups work.
  await globalThis.services.db
    .update(agentSessions)
    .set({ conversationId: conversation!.id })
    .where(eq(agentSessions.id, session.id));
  return session;
}

/**
 * Set last_read_at on a chat thread directly in the database.
 *
 * @why-db-direct Legacy tests may need to seed the compatibility timestamp
 * field directly. The mark-read API now derives read state from
 * last_read_message_id instead.
 */
export async function setTestChatThreadLastReadAt(
  threadId: string,
  lastReadAt: Date | null,
): Promise<void> {
  initServices();
  await globalThis.services.db
    .update(chatThreads)
    .set({ lastReadAt })
    .where(eq(chatThreads.id, threadId));
}

/**
 * Set pinned_at on a chat thread directly in the database.
 *
 * @why-db-direct The pin/unpin route is exercised in its own route test;
 * list-route ordering tests need to seed an arbitrary pinned state to
 * assert the new ORDER BY without round-tripping the auth/clerk-mocked POST.
 */
export async function setTestChatThreadPinnedAt(
  threadId: string,
  pinnedAt: Date | null,
): Promise<void> {
  initServices();
  await globalThis.services.db
    .update(chatThreads)
    .set({ pinnedAt })
    .where(eq(chatThreads.id, threadId));
}

/**
 * Set renamed_at on a chat thread directly in the database.
 *
 * @why-db-direct Tests that need to seed a user-renamed state to assert
 * the automated-title-generation suppression logic require direct access.
 */
export async function setTestChatThreadRenamedAt(
  threadId: string,
  renamedAt: Date | null,
): Promise<void> {
  initServices();
  await globalThis.services.db
    .update(chatThreads)
    .set({ renamedAt })
    .where(eq(chatThreads.id, threadId));
}

/**
 * Set the model-first pin columns on a chat thread.
 *
 * @why-db-direct Model pins are persisted by the chat send route. Tests need to
 * model legacy threads that predate those columns being populated.
 */
export async function setTestChatThreadModelPin(
  threadId: string,
  pin: {
    modelProviderId?: string | null;
    modelProviderType?: string | null;
    modelProviderCredentialScope?: string | null;
    selectedModel?: string | null;
  },
): Promise<void> {
  initServices();
  await globalThis.services.db
    .update(chatThreads)
    .set(pin)
    .where(eq(chatThreads.id, threadId));
}

/**
 * Set last_read_message_id on a chat thread directly in the database.
 *
 * @why-db-direct Tests need to seed exact read state without invoking the
 * mark-read API, which derives the value from the current latest message.
 */
export async function setTestChatThreadLastReadMessageId(
  threadId: string,
  lastReadMessageId: string | null,
): Promise<void> {
  initServices();
  await globalThis.services.db
    .update(chatThreads)
    .set({ lastReadMessageId })
    .where(eq(chatThreads.id, threadId));
}

/**
 * Set draft_content / draft_attachments on a chat thread directly.
 *
 * @why-db-direct The draft PATCH route is exercised in its own route test;
 * list-route tests need to seed an arbitrary draft state to verify the
 * `hasDraft` projection without round-tripping the auth/clerk-mocked PATCH.
 */
export async function setTestChatThreadDraft(
  threadId: string,
  draftContent: string | null,
  draftAttachments: Array<{
    id: string;
    url: string;
    filename: string;
    contentType: string;
    size: number;
  }> | null,
): Promise<void> {
  initServices();
  await globalThis.services.db
    .update(chatThreads)
    .set({ draftContent, draftAttachments })
    .where(eq(chatThreads.id, threadId));
}

/**
 * Insert a chat thread directly in the database.
 * Returns the thread ID.
 *
 * @why-db-direct Chat threads are created as side effects of run
 * completion, not via a direct creation API endpoint.
 */
export async function insertTestChatThread(
  userId: string,
  agentComposeId: string,
  title: string,
): Promise<string> {
  initServices();
  const result = await globalThis.services.db.execute<{ id: string }>(sql`
    INSERT INTO ${chatThreads} (user_id, agent_compose_id, title)
    VALUES (${userId}, ${agentComposeId}::uuid, ${title})
    RETURNING id
  `);
  const threadId = result.rows[0]?.id;
  if (!threadId) {
    throw new Error("Failed to seed chat thread");
  }
  return threadId;
}

/**
 * Delete a chat thread directly in the database.
 *
 * @why-db-direct Tests need to model stale callbacks arriving after the
 * user-facing thread row has already been deleted.
 */
export async function deleteTestChatThread(threadId: string): Promise<void> {
  initServices();
  await globalThis.services.db
    .delete(chatThreads)
    .where(eq(chatThreads.id, threadId));
}

// ---------------------------------------------------------------------------
// Chat message seeders (service wrappers for test data setup)
// ---------------------------------------------------------------------------

/**
 * Insert a chat message directly into the chat_messages table.
 *
 * @why-db-direct Chat messages are created by the run flow and event
 * consumers, not a standalone API endpoint. Tests need direct seeding.
 * Bypasses insertChatMessage so seeding does not fan out Ably publishes
 * that would pollute assertions.
 */
export async function insertTestChatMessage(params: {
  chatThreadId: string;
  // Accepted for API parity with insertChatMessage but unused here — seeding
  // intentionally skips realtime publishes.
  userId?: string;
  role: "user" | "assistant";
  content: string | null;
  runId?: string | null;
  interruptsRunId?: string | null;
  attachFiles?: string[];
  createdAt?: Date;
}): Promise<{ id: string; createdAt: Date }> {
  initServices();
  const [row] = await globalThis.services.db
    .insert(chatMessages)
    .values({
      chatThreadId: params.chatThreadId,
      role: params.role,
      content: params.content,
      runId: params.runId ?? null,
      interruptsRunId: params.interruptsRunId ?? null,
      attachFiles: params.attachFiles ?? null,
      ...(params.createdAt ? { createdAt: params.createdAt } : {}),
    })
    .returning({ id: chatMessages.id, createdAt: chatMessages.createdAt });
  if (!row) {
    throw new Error("Failed to seed chat message");
  }
  return row;
}

/**
 * Get chat messages for a thread from the chat_messages table.
 *
 * @why-db-direct No API route returns raw chat_messages rows with
 * run status; tests need this for assertion.
 */
export async function getTestChatMessagesByThread(
  threadId: string,
): Promise<Awaited<ReturnType<typeof getMessagesByThreadId>>> {
  return getMessagesByThreadId(threadId);
}

/**
 * Link a run to a chat thread by inserting a user message and setting
 * zero_runs.chat_thread_id so getChatThreadIdForRun can resolve the thread.
 *
 * @why-db-direct Run-to-thread linking happens inside the chat messages
 * API route during run dispatch. Tests need direct seeding for isolated setup.
 */
export async function addTestRunToThread(
  threadId: string,
  runId: string,
  _userId: string,
  prompt?: string,
): Promise<{ messageId: string }> {
  initServices();
  return globalThis.services.db.transaction(async (tx) => {
    const [message] = await tx
      .insert(chatMessages)
      .values({
        chatThreadId: threadId,
        role: "user",
        content: prompt ?? "test prompt",
        runId,
      })
      .returning({ id: chatMessages.id });
    if (!message) {
      throw new Error("Failed to seed chat message");
    }
    await tx
      .update(zeroRuns)
      .set({ chatThreadId: threadId })
      .where(eq(zeroRuns.id, runId));
    return { messageId: message.id };
  });
}

/**
 * Overwrite `chat_messages.attach_files` for every row belonging to a run.
 *
 * @why-db-direct Send-time inserts only stamp IDs for the user row. Tests
 * that stand up a cancelled round with attachments must backfill this blob
 * after the send endpoint persists the row.
 */
export async function setTestChatMessageAttachFiles(
  runId: string,
  ids: string[],
): Promise<void> {
  initServices();
  await globalThis.services.db
    .update(chatMessages)
    .set({ attachFiles: ids })
    .where(eq(chatMessages.runId, runId));
}

/**
 * Overwrite `chat_messages.content` for every row belonging to a run.
 *
 * @why-db-direct Simulates an overlong user body without exercising the
 * body-length limits enforced by the public API.
 */
export async function setTestChatMessageContent(
  runId: string,
  content: string,
): Promise<void> {
  initServices();
  await globalThis.services.db
    .update(chatMessages)
    .set({ content })
    .where(eq(chatMessages.runId, runId));
}

/**
 * Insert event-backed assistant messages for a run.
 *
 * @why-db-direct Event-backed messages are inserted by the chat-assistant
 * event consumer, not an API endpoint. Tests need direct seeding. Bypasses
 * insertAssistantEventMessages so seeding does not fan out Ably publishes
 * that would pollute assertions.
 */
export async function insertTestAssistantEventMessages(
  runId: string,
  threadId: string,
  // Accepted for API parity with insertAssistantEventMessages but unused —
  // seeding intentionally skips realtime publishes.
  _userId: string,
  items: { sequenceNumber: number; content: string }[],
): Promise<number> {
  if (items.length === 0) return 0;
  initServices();
  const rows = await globalThis.services.db
    .insert(chatMessages)
    .values(
      items.map((item) => {
        return {
          chatThreadId: threadId,
          runId,
          role: "assistant" as const,
          content: item.content,
          sequenceNumber: item.sequenceNumber,
        };
      }),
    )
    .onConflictDoNothing({
      target: [chatMessages.runId, chatMessages.sequenceNumber],
    })
    .returning({ id: chatMessages.id });
  return rows.length;
}
