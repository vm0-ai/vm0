import { and, eq, sql } from "drizzle-orm";
import type { RawPermissionPolicies } from "@vm0/connectors/firewall-types";
import { initServices } from "../../lib/init-services";
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
import { composeJobs } from "@vm0/db/schema/compose-job";
import { uniqueId } from "../test-helpers";
import { getMessagesByThreadId } from "../../lib/zero/chat-thread/chat-message-service";
import type { ContextArtifact } from "../../lib/infra/run/types";

/**
 * @why-db-direct Creates compose + zero_agents WITHOUT a version — API always
 * creates a version. Tests that need a compose with a specific userId/orgId
 * outside of Clerk auth context (e.g., backfill scripts).
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
 * @why-db-direct Creates compose WITHOUT zero_agents row — API always creates
 * both. Tests "agent not found" scenarios where getWorkspaceAgent() returns
 * undefined despite compose FK being satisfied.
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
 * @why-db-direct Sets HEAD to an arbitrary version — API always sets HEAD to
 * the latest created version. Tests stale-version handling in recompose flows.
 */
export async function setComposeHeadVersion(
  composeId: string,
  headVersionId: string,
): Promise<void> {
  initServices();
  await globalThis.services.db
    .update(agentComposes)
    .set({ headVersionId })
    .where(eq(agentComposes.id, composeId));
}

/**
 * @why-db-direct Sets HEAD to null — API never creates a versionless compose.
 * Tests pre-run failure when no version exists (e.g., executeSchedule).
 */
export async function clearComposeHeadVersion(
  composeId: string,
): Promise<void> {
  initServices();
  await globalThis.services.db
    .update(agentComposes)
    .set({ headVersionId: null })
    .where(eq(agentComposes.id, composeId));
}

/**
 * @why-db-direct Transfers compose between orgs — no API for org transfer.
 * Tests org-scoped installations for composes created in other orgs.
 */
export async function updateAgentComposeOrg(
  composeId: string,
  orgId: string,
): Promise<void> {
  initServices();
  await globalThis.services.db
    .update(agentComposes)
    .set({ orgId })
    .where(eq(agentComposes.id, composeId));
}

/**
 * @why-db-direct Direct compose_jobs insert — compose jobs are created by
 * internal pipeline, not user API. Tests compose job cleanup on deletion.
 */
export async function insertTestComposeJob(params: {
  userId: string;
  status?: string;
  githubUrl?: string;
}): Promise<{ id: string }> {
  initServices();
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
 * @why-db-direct Upserts zero_agents with permissionPolicies —
 * permissionPolicies is not settable via any API route. Tests agent
 * permission policy enforcement.
 */
export async function createTestZeroAgent(
  orgId: string,
  name: string,
  metadata: {
    displayName?: string;
    description?: string;
    sound?: string;
    permissionPolicies?: RawPermissionPolicies;
    modelProviderId?: string | null;
    selectedModel?: string | null;
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
      modelProviderId: metadata.modelProviderId ?? null,
      selectedModel: metadata.selectedModel ?? null,
    })
    .onConflictDoUpdate({
      target: [zeroAgents.orgId, zeroAgents.name],
      set: {
        displayName: metadata.displayName ?? null,
        description: metadata.description ?? null,
        sound: metadata.sound ?? null,
        permissionPolicies: metadata.permissionPolicies ?? null,
        modelProviderId: metadata.modelProviderId ?? null,
        selectedModel: metadata.selectedModel ?? null,
      },
    });
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

/**
 * @why-db-direct Deletes compose bypassing running-run check that API
 * enforces. Tests compose deletion in cleanup flows.
 */
export async function deleteTestCompose(composeId: string): Promise<void> {
  initServices();
  await globalThis.services.db
    .delete(agentComposes)
    .where(eq(agentComposes.id, composeId));
}

// ---------------------------------------------------------------------------
// Session / conversation seeders (migrated from api-test-helpers/agents.ts)
// ---------------------------------------------------------------------------

/**
 * Pin a zero_agents row to a specific model provider + selected-model pair.
 * Used by tests that need an agent whose default provider is explicitly set,
 * so chat-thread eager-pin paths can be exercised.
 *
 * @why-db-direct The agent provider pin is normally set by compose creation /
 * agent edit API routes; tests need a direct setter for isolated setup.
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
  archivedAt?: Date | null;
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
      archivedAt: params.archivedAt ?? null,
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
): Promise<void> {
  initServices();
  await globalThis.services.db.insert(chatMessages).values({
    chatThreadId: threadId,
    role: "user",
    content: prompt ?? "test prompt",
    runId,
  });
  await globalThis.services.db
    .update(zeroRuns)
    .set({ chatThreadId: threadId })
    .where(eq(zeroRuns.id, runId));
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
 * Overwrite `agent_sessions.artifacts` for a session.
 *
 * @why-db-direct `agent_sessions.artifacts` is written by the run pipeline
 * from the resolved artifact list. Resolver tests need to seed arbitrary
 * artifact lists (including the auto-memory entry) to exercise downstream
 * consumers.
 */
export async function setTestSessionArtifacts(
  sessionId: string,
  artifacts: ContextArtifact[],
): Promise<void> {
  initServices();
  await globalThis.services.db
    .update(agentSessions)
    .set({ artifacts })
    .where(eq(agentSessions.id, sessionId));
}

/**
 * Update the cliAgentType on the conversation linked to a session.
 *
 * @why-db-direct Test checkpoint helpers seed conversations with
 * cliAgentType "test-agent" while composes default to framework
 * "claude-code". Resolver compatibility checks compare these, so
 * resolveSession tests need to align the conversation framework before
 * invoking the resolver.
 */
export async function setTestSessionFramework(
  sessionId: string,
  framework: string,
): Promise<void> {
  initServices();
  const [session] = await globalThis.services.db
    .select({ conversationId: agentSessions.conversationId })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  if (!session?.conversationId) {
    throw new Error(`Session ${sessionId} has no conversation`);
  }
  await globalThis.services.db
    .update(conversations)
    .set({ cliAgentType: framework })
    .where(eq(conversations.id, session.conversationId));
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
