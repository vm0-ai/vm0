import { describe, it, expect } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { checkpoints } from "@vm0/db/schema/checkpoint";
import { conversations } from "@vm0/db/schema/conversation";
import { db, uniqueId } from "../test-db";

/**
 * Integration test for migration 0311 body.
 *
 * Migration 0311 backfills `agent_sessions.artifacts` with the memory entry
 * lifted from the most recent memory-bearing checkpoint. The migration has
 * already run against the shared test DB, so we seed a pre-migration shape
 * (session with `artifacts: []` + checkpoint carrying memory in
 * `artifact_snapshots`) and execute the verbatim UPDATE body against the
 * real tables. The migration's guard (`NOT (s.artifacts @> ...)`) makes
 * re-runs idempotent, so running it again does not disturb data created by
 * prior test cases.
 */

const MEMORY_ENTRY = {
  name: "memory",
  mountPath: "/home/user/.claude/projects/-home-user-workspace/memory",
};

type TestArtifact = {
  name: string;
  mountPath: string;
};

async function setupSessionAndRun(): Promise<{
  sessionId: string;
  runId: string;
}> {
  const userId = uniqueId("user");
  const orgId = uniqueId("org");
  const [compose] = await db
    .insert(agentComposes)
    .values({
      userId,
      orgId,
      name: uniqueId("compose"),
    })
    .returning({ id: agentComposes.id });

  const versionId = uniqueId("version");
  await db.insert(agentComposeVersions).values({
    id: versionId,
    composeId: compose!.id,
    content: { name: "test-agent" },
    createdBy: userId,
  });

  const [session] = await db
    .insert(agentSessions)
    .values({
      userId,
      orgId,
      agentComposeId: compose!.id,
      artifacts: [],
    })
    .returning({ id: agentSessions.id });

  const [run] = await db
    .insert(agentRuns)
    .values({
      userId,
      orgId,
      agentComposeVersionId: versionId,
      status: "completed",
      prompt: "test",
      sessionId: session!.id,
    })
    .returning({ id: agentRuns.id, sessionId: agentRuns.sessionId });

  return { sessionId: run!.sessionId, runId: run!.id };
}

async function insertConversation(runId: string): Promise<string> {
  const [conversation] = await db
    .insert(conversations)
    .values({
      runId,
      cliAgentType: "claude",
      cliAgentSessionId: uniqueId("claude-session"),
    })
    .returning({ id: conversations.id });

  return conversation!.id;
}

async function seedCheckpointDirect(
  runId: string,
  artifactSnapshots: TestArtifact[],
): Promise<void> {
  const [conversation] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.runId, runId))
    .limit(1);

  await db.insert(checkpoints).values({
    runId,
    conversationId: conversation!.id,
    agentComposeSnapshot: { name: "test-agent" },
    artifactSnapshots,
  });
}

async function getAgentSessionArtifacts(
  sessionId: string,
): Promise<TestArtifact[]> {
  const [session] = await db
    .select({ artifacts: agentSessions.artifacts })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);

  return session?.artifacts ?? [];
}

async function setAgentSessionArtifacts(
  sessionId: string,
  artifacts: TestArtifact[],
): Promise<void> {
  await db
    .update(agentSessions)
    .set({ artifacts })
    .where(eq(agentSessions.id, sessionId));
}

async function runBackfill(): Promise<void> {
  await db.execute(sql`
    UPDATE agent_sessions AS s
    SET artifacts = s.artifacts || (
      SELECT (
        SELECT entry
        FROM jsonb_array_elements(c.artifact_snapshots) AS entry
        WHERE entry->>'name' = 'memory'
        LIMIT 1
      )
      FROM checkpoints c
      JOIN agent_runs r ON r.id = c.run_id
      WHERE r.session_id = s.id
        AND c.artifact_snapshots @> '[{"name":"memory"}]'::jsonb
      ORDER BY c.created_at DESC
      LIMIT 1
    )
    WHERE NOT (s.artifacts @> '[{"name":"memory"}]'::jsonb)
      AND EXISTS (
        SELECT 1
        FROM checkpoints c
        JOIN agent_runs r ON r.id = c.run_id
        WHERE r.session_id = s.id
          AND c.artifact_snapshots @> '[{"name":"memory"}]'::jsonb
      );
  `);
}

describe("migration 0311 backfill session memory artifact", () => {
  it("appends the memory entry when the session has an empty artifacts list and a memory-bearing checkpoint exists", async () => {
    const { sessionId, runId } = await setupSessionAndRun();
    await insertConversation(runId);
    await seedCheckpointDirect(runId, [MEMORY_ENTRY]);

    expect(await getAgentSessionArtifacts(sessionId)).toEqual([]);
    await runBackfill();

    expect(await getAgentSessionArtifacts(sessionId)).toEqual([MEMORY_ENTRY]);
  });

  it("leaves sessions unchanged when no checkpoint carries a memory snapshot", async () => {
    const { sessionId, runId } = await setupSessionAndRun();
    await insertConversation(runId);
    await seedCheckpointDirect(runId, [
      { name: "other", mountPath: "/mnt/other" },
    ]);

    await runBackfill();

    expect(await getAgentSessionArtifacts(sessionId)).toEqual([]);
  });

  it("does not duplicate memory when the session already has it (idempotent)", async () => {
    const { sessionId, runId } = await setupSessionAndRun();
    await insertConversation(runId);
    await seedCheckpointDirect(runId, [MEMORY_ENTRY]);
    await setAgentSessionArtifacts(sessionId, [MEMORY_ENTRY]);

    await runBackfill();
    await runBackfill();

    expect(await getAgentSessionArtifacts(sessionId)).toEqual([MEMORY_ENTRY]);
  });
});
