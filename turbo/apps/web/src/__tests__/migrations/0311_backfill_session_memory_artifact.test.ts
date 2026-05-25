import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { testContext } from "../test-helpers";
import {
  seedTestRun,
  insertTestConversation,
  seedTestCheckpointDirect,
  setTestAgentSessionArtifacts,
} from "../db-test-seeders/runs";
import { findTestRunRecord } from "../db-test-assertions/runs";
import { getTestAgentSessionArtifacts } from "../db-test-assertions/agents";

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

const context = testContext();

const MEMORY_ENTRY = {
  name: "memory",
  mountPath: "/home/user/.claude/projects/-home-user-workspace/memory",
};

async function setupSessionAndRun(): Promise<{
  sessionId: string;
  runId: string;
}> {
  const user = await context.setupUser();
  const compose = await context.createAgentCompose(user.userId);
  const { runId } = await seedTestRun(user.userId, compose.id, {
    orgId: compose.orgId,
  });
  const run = await findTestRunRecord(runId);
  return { sessionId: run!.sessionId, runId };
}

async function runBackfill(): Promise<void> {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: executes the verbatim backfill body against real tables
  await globalThis.services.db.execute(sql`
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
  beforeEach(() => {
    context.setupMocks();
  });

  it("appends the memory entry when the session has an empty artifacts list and a memory-bearing checkpoint exists", async () => {
    const { sessionId, runId } = await setupSessionAndRun();
    await insertTestConversation({ runId });
    await seedTestCheckpointDirect(runId, [MEMORY_ENTRY]);

    expect(await getTestAgentSessionArtifacts(sessionId)).toEqual([]);
    await runBackfill();

    expect(await getTestAgentSessionArtifacts(sessionId)).toEqual([
      MEMORY_ENTRY,
    ]);
  });

  it("leaves sessions unchanged when no checkpoint carries a memory snapshot", async () => {
    const { sessionId, runId } = await setupSessionAndRun();
    await insertTestConversation({ runId });
    await seedTestCheckpointDirect(runId, [
      { name: "other", mountPath: "/mnt/other" },
    ]);

    await runBackfill();

    expect(await getTestAgentSessionArtifacts(sessionId)).toEqual([]);
  });

  it("does not duplicate memory when the session already has it (idempotent)", async () => {
    const { sessionId, runId } = await setupSessionAndRun();
    await insertTestConversation({ runId });
    await seedTestCheckpointDirect(runId, [MEMORY_ENTRY]);
    await setTestAgentSessionArtifacts(sessionId, [MEMORY_ENTRY]);

    await runBackfill();
    await runBackfill();

    expect(await getTestAgentSessionArtifacts(sessionId)).toEqual([
      MEMORY_ENTRY,
    ]);
  });
});
