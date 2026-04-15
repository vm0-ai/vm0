import { and, eq } from "drizzle-orm";
import type { RawPermissionPolicies } from "@vm0/core";
import { initServices } from "../../lib/init-services";
import {
  agentComposes,
  agentComposeVersions,
} from "../../db/schema/agent-compose";
import { agentRuns } from "../../db/schema/agent-run";
import { agentSessions } from "../../db/schema/agent-session";
import { chatThreads } from "../../db/schema/chat-thread";
import { conversations } from "../../db/schema/conversation";
import { zeroAgents } from "../../db/schema/zero-agent";
import {
  zeroAgentSessions,
  type StoredChatMessage,
} from "../../db/schema/zero-agent-session";
import { composeJobs } from "../../db/schema/compose-job";
import { uniqueId } from "../test-helpers";
import {
  insertChatMessage,
  getMessagesByThreadId,
  insertAssistantEventMessages,
  updateAssistantMessageByRunId,
} from "../../lib/zero/chat-thread/chat-message-service";

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
 * @why-db-direct Inserts session with specific chat messages; no API
 * exists for direct message injection into agent sessions.
 */
export async function insertTestAgentSessionWithMessages(
  userId: string,
  agentComposeId: string,
  chatMessages: StoredChatMessage[],
) {
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
  await globalThis.services.db
    .insert(zeroAgentSessions)
    .values({ id: session!.id, chatMessages });
  return session!;
}

/**
 * Append chat messages to a zero_agent_sessions record.
 *
 * @why-db-direct Appends to zero_agent_sessions chat history; no API
 * exists for direct history manipulation.
 */
export async function appendTestChatMessages(
  sessionId: string,
  messages: StoredChatMessage[],
): Promise<void> {
  initServices();
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
  const [thread] = await globalThis.services.db
    .insert(chatThreads)
    .values({ userId, agentComposeId, title })
    .returning({ id: chatThreads.id });
  return thread!.id;
}

// ---------------------------------------------------------------------------
// Chat message seeders (service wrappers for test data setup)
// ---------------------------------------------------------------------------

/**
 * Insert a chat message directly into the chat_messages table.
 *
 * @why-db-direct Chat messages are created by the run flow and event
 * consumers, not a standalone API endpoint. Tests need direct seeding.
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
 * Link a run to a chat thread by inserting chat messages (user + assistant placeholder).
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
 * Insert event-backed assistant messages for a run.
 *
 * @why-db-direct Event-backed messages are inserted by the chat-assistant
 * event consumer, not an API endpoint. Tests need direct seeding.
 */
export async function insertTestAssistantEventMessages(
  runId: string,
  threadId: string,
  items: { sequenceNumber: number; content: string }[],
): Promise<number> {
  return insertAssistantEventMessages(runId, threadId, items);
}

/**
 * Update an assistant placeholder message with content/error from the run callback.
 *
 * @why-db-direct Placeholder updates happen inside the chat callback
 * route handler. Tests need direct seeding for setup.
 */
export async function updateTestAssistantMessageByRunId(
  runId: string,
  content: string | null,
  error: string | undefined,
): Promise<void> {
  return updateAssistantMessageByRunId(runId, content, error);
}
