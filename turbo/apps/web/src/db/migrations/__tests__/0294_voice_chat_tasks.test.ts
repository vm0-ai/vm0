import { describe, it, expect, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { testContext, uniqueId } from "../../../__tests__/test-helpers";
import { initServices } from "../../../lib/init-services";
import { agentRuns } from "../../schema/agent-run";
import { agentSessions } from "../../schema/agent-session";
import {
  agentComposes,
  agentComposeVersions,
} from "../../schema/agent-compose";
import { voiceChatSessions, voiceChatTasks } from "../../schema/voice-chat";

const context = testContext();

async function seedComposeVersion(
  userId: string,
  orgId: string,
): Promise<string> {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: raw row seeding
  const [compose] = await globalThis.services.db
    .insert(agentComposes)
    .values({ userId, orgId, name: uniqueId("compose") })
    .returning({ id: agentComposes.id });

  const versionId = uniqueId("version");
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: raw row seeding
  await globalThis.services.db.insert(agentComposeVersions).values({
    id: versionId,
    composeId: compose!.id,
    content: { name: "test-agent" },
    createdBy: userId,
  });

  return versionId;
}

async function seedAgentSession(
  userId: string,
  orgId: string,
): Promise<string> {
  const versionId = await seedComposeVersion(userId, orgId);
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: raw row seeding
  const [compose] = await globalThis.services.db
    .select({ composeId: agentComposeVersions.composeId })
    .from(agentComposeVersions)
    .where(eq(agentComposeVersions.id, versionId))
    .limit(1);
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: raw row seeding
  const [session] = await globalThis.services.db
    .insert(agentSessions)
    .values({ userId, orgId, agentComposeId: compose!.composeId })
    .returning({ id: agentSessions.id });
  return session!.id;
}

async function seedVoiceChatSession(
  userId: string,
  orgId: string,
): Promise<string> {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: raw row seeding
  const [row] = await globalThis.services.db
    .insert(voiceChatSessions)
    .values({ userId, orgId, status: "active" })
    .returning({ id: voiceChatSessions.id });
  return row!.id;
}

async function seedAgentRun(
  userId: string,
  orgId: string,
  agentSessionId: string,
): Promise<string> {
  const versionId = await seedComposeVersion(userId, orgId);
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: raw row seeding
  const [run] = await globalThis.services.db
    .insert(agentRuns)
    .values({
      userId,
      orgId,
      agentComposeVersionId: versionId,
      status: "completed",
      prompt: "seed",
      sessionId: agentSessionId,
    })
    .returning({ id: agentRuns.id });
  return run!.id;
}

describe("migration 0294 voice_chat_tasks", () => {
  beforeEach(() => {
    context.setupMocks();
    // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: needs services initialised for raw SQL
    initServices();
  });

  it("cascades DELETE on voice_chat_sessions to voice_chat_tasks", async () => {
    const userId = uniqueId("user");
    const orgId = uniqueId("org");
    const voiceSessionId = await seedVoiceChatSession(userId, orgId);

    // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: raw row seeding
    const [task] = await globalThis.services.db
      .insert(voiceChatTasks)
      .values({ sessionId: voiceSessionId, prompt: "task", status: "pending" })
      .returning({ id: voiceChatTasks.id });
    const taskId = task!.id;

    // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: triggers cascade delete
    await globalThis.services.db
      .delete(voiceChatSessions)
      .where(eq(voiceChatSessions.id, voiceSessionId));

    // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: read-back assertion
    const rows = await globalThis.services.db
      .select()
      .from(voiceChatTasks)
      .where(eq(voiceChatTasks.id, taskId));
    expect(rows).toHaveLength(0);
  });

  it("sets run_id to NULL when the referenced agent_run is deleted", async () => {
    const userId = uniqueId("user");
    const orgId = uniqueId("org");
    const voiceSessionId = await seedVoiceChatSession(userId, orgId);
    const agentSessionId = await seedAgentSession(userId, orgId);
    const runId = await seedAgentRun(userId, orgId, agentSessionId);

    // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: raw row seeding
    const [task] = await globalThis.services.db
      .insert(voiceChatTasks)
      .values({
        sessionId: voiceSessionId,
        runId,
        prompt: "task",
        status: "running",
      })
      .returning({ id: voiceChatTasks.id });
    const taskId = task!.id;

    // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: triggers SET NULL cascade
    await globalThis.services.db
      .delete(agentRuns)
      .where(eq(agentRuns.id, runId));

    // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: read-back assertion
    const [row] = await globalThis.services.db
      .select({
        id: voiceChatTasks.id,
        runId: voiceChatTasks.runId,
        status: voiceChatTasks.status,
      })
      .from(voiceChatTasks)
      .where(eq(voiceChatTasks.id, taskId));
    expect(row).toBeDefined();
    expect(row!.runId).toBeNull();
    expect(row!.status).toBe("running");
  });

  it("defaults assistant_messages to an empty array", async () => {
    const userId = uniqueId("user");
    const orgId = uniqueId("org");
    const voiceSessionId = await seedVoiceChatSession(userId, orgId);

    // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: raw row seeding
    const [task] = await globalThis.services.db
      .insert(voiceChatTasks)
      .values({ sessionId: voiceSessionId, prompt: "task", status: "pending" })
      .returning({
        id: voiceChatTasks.id,
        assistantMessages: voiceChatTasks.assistantMessages,
      });

    expect(task!.assistantMessages).toEqual([]);
  });

  it("creates the composite (session_id, status, created_at) index", async () => {
    // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: inspects pg_indexes metadata
    const result = await globalThis.services.db.execute(sql`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename = 'voice_chat_tasks'
        AND indexname = 'idx_voice_chat_tasks_session_status_created'
    `);
    expect(result.rows).toHaveLength(1);
  });
});
