import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { setTimeout } from "node:timers/promises";
import { Client } from "pg";
import postgres from "postgres";
import { chatEventRowSchema } from "@okouai/api-contracts/contracts/chat-event-rows";
import { chatEventFromRow } from "@okouai/api-contracts/contracts/chat-event-row-projection";
import { applyPendingMigrations } from "./migration-runner";

// Historical rows and migration interruption have no public creation API after
// S1. Exercise the real SQL, journal and PostgreSQL locks in a private database.
const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const database = `migration_goals_${randomUUID().replaceAll("-", "")}`;
const adminUrl = new URL(databaseUrl);
adminUrl.pathname = "/postgres";
const testUrl = new URL(databaseUrl);
testUrl.pathname = `/${database}`;
const admin = new Client({ connectionString: adminUrl.toString() });
await admin.connect();
await admin.query(`CREATE DATABASE "${database}"`);
const client = new Client({ connectionString: testUrl.toString() });
const other = new Client({ connectionString: testUrl.toString() });
await client.connect();
await other.connect();
const notices: string[] = [];
const migration = postgres(testUrl.toString(), {
  max: 1,
  onnotice: (notice) => {
    if (notice.message !== undefined) {
      notices.push(notice.message);
    }
  },
});
const directory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../src/migrations",
);
const fixtureDirectory = await mkdtemp(join(tmpdir(), "goal-retirement-"));
const originalDirectory = process.cwd();
const fixtureMigrations = join(fixtureDirectory, "src/migrations");
const journal = JSON.parse(
  await readFile(join(directory, "meta/_journal.json"), "utf8"),
) as {
  entries: { idx: number; tag: string; when: number }[];
};
const archiveEntry = journal.entries.find((entry) => {
  return entry.tag === "1094_archive_retired_goals";
});
assert.ok(archiveEntry, "Goal retirement transition migration is missing");
const archiveSql = await readFile(
  join(directory, `${archiveEntry.tag}.sql`),
  "utf8",
);
const statements = archiveSql
  .split("--> statement-breakpoint")
  .filter((statement) => {
    return statement.trim().length > 0;
  });
const procedure = statements.find((statement) => {
  return statement.includes("CREATE OR REPLACE PROCEDURE");
});
assert.ok(procedure);
const objective =
  " \n完整目标 🧭 e\u0301 中文\t\r\n```sql\n'quoted'; $$ | </tag>\n```\n\n";

async function applyThrough(includeArchive: boolean) {
  const entries = journal.entries.filter((entry) => {
    return includeArchive
      ? entry.idx <= archiveEntry!.idx
      : entry.idx < archiveEntry!.idx;
  });
  await mkdir(join(fixtureMigrations, "meta"), { recursive: true });
  for (const entry of entries) {
    await copyFile(
      join(directory, `${entry.tag}.sql`),
      join(fixtureMigrations, `${entry.tag}.sql`),
    );
  }
  await writeFile(
    join(fixtureMigrations, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries }),
  );
  process.chdir(fixtureDirectory);
  await applyPendingMigrations(migration);
}

async function replay() {
  for (const statement of statements) {
    await migration.unsafe(statement);
  }
}

async function count(query: string, parameters: unknown[] = []) {
  const result = await client.query<{ count: string }>(query, parameters);
  return Number(result.rows[0]?.count);
}

async function clear() {
  await client.query("DELETE FROM agents");
  // Runs attached to agent-less historical sessions are fixture-owned too.
  await client.query("DELETE FROM agent_sessions");
}

async function seedGoal(status = "active", threadId = randomUUID()) {
  const agentId = randomUUID();
  const goalId = randomUUID();
  await client.query(
    "INSERT INTO agents (id, org_id, owner, name) VALUES ($1::uuid, 'goal-test-org', 'shared-agent-owner', $1::uuid::text)",
    [agentId],
  );
  await client.query(
    "INSERT INTO chat_threads (id, agent_id, user_id) VALUES ($1, $2, 'thread-owner')",
    [threadId, agentId],
  );
  await client.query(
    `INSERT INTO thread_goals (id, org_id, owner_user_id, agent_id, chat_thread_id, status, objective, objective_brief)
    VALUES ($1, 'goal-test-org', 'thread-owner', $2, $3, $4, $5, 'brief is not the objective')`,
    [goalId, agentId, threadId, status, objective],
  );
  return { goalId, agentId, threadId };
}

async function seedRun(
  goalId: string | null,
  triggerSource: "web" | "goal",
  status = "pending",
) {
  const sessionId = randomUUID();
  const runId = randomUUID();
  await client.query(
    "INSERT INTO agent_sessions (id, user_id, org_id) VALUES ($1, 'thread-owner', 'goal-test-org')",
    [sessionId],
  );
  await client.query(
    `INSERT INTO agent_runs (id, user_id, org_id, session_id, status, prompt, trigger_source, autonomy_budget, goal_id)
    VALUES ($1, 'thread-owner', 'goal-test-org', $2, $3, 'fixture', $4, 1, $5)`,
    [runId, sessionId, status, triggerSource, goalId],
  );
  return runId;
}

async function appendInput(
  threadId: string,
  goalId: string,
  runId: string | null = null,
  revokesId: string | null = null,
) {
  const result = await client.query<{ id: string }>(
    `WITH reservation AS (
    UPDATE chat_threads SET last_chat_event_seq_id = last_chat_event_seq_id + 1 WHERE id = $1 RETURNING last_chat_event_seq_id
  ) INSERT INTO chat_events (chat_thread_id, event_type, context_type, context_id, run_id, revokes_event_id, payload, seq_id, created_at)
    SELECT $1, 'input.goal', 'goal', $2, $3, $4, '{"userMessage":{"version":1,"parts":[{"type":"text","text":"fixture input"}]}}',
      last_chat_event_seq_id, timestamp '2099-01-01' + last_chat_event_seq_id * interval '1 millisecond'
    FROM reservation RETURNING id`,
    [threadId, goalId, runId, revokesId],
  );
  return result.rows[0]!.id;
}

async function expectFailure(
  operation: () => Promise<unknown>,
  pattern: RegExp,
) {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, pattern);
    assert.ok(!JSON.stringify(error).includes(objective));
    assert.ok(!JSON.stringify(error).includes("sensitive fixture detail"));
    return true;
  });
}

async function assertSettled() {
  assert.equal(
    await count(
      "SELECT count(*) FROM thread_goals WHERE status = 'active' OR retirement_archive_event_id IS NULL",
    ),
    0,
  );
  assert.equal(
    await count(`SELECT count(*) FROM chat_events e WHERE e.event_type = 'input.goal' AND e.run_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM chat_events r WHERE r.revokes_event_id = e.id)`),
    0,
  );
}

async function installBarrier(threadId: string) {
  await client.query(`CREATE OR REPLACE FUNCTION goal_test_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.event_type = 'output.message' AND NEW.chat_thread_id = '${threadId}'::uuid THEN
      PERFORM pg_advisory_xact_lock(32797, 1);
    END IF; RETURN NEW; END; $$;
    CREATE TRIGGER goal_test_barrier BEFORE INSERT ON chat_events FOR EACH ROW EXECUTE FUNCTION goal_test_barrier()`);
  await other.query("SELECT pg_advisory_lock(32797, 1)");
}

async function waitForBlocked(pid: number) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const waiting = await client.query<{ blocked: boolean }>(
      "SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked",
      [pid],
    );
    if (waiting.rows[0]?.blocked) {
      return;
    }
    await setTimeout(10);
  }
  throw new Error(`Expected blocked PostgreSQL backend ${pid}`);
}

async function removeBarrier() {
  await other.query("SELECT pg_advisory_unlock(32797, 1)");
  await client.query(
    "DROP TRIGGER goal_test_barrier ON chat_events; DROP FUNCTION goal_test_barrier()",
  );
}

try {
  await applyThrough(false);
  const first = await seedGoal(
    "complete",
    "00000000-0000-4000-8000-000000000001",
  );
  const broken = await seedGoal(
    "active",
    "00000000-0000-4000-8000-000000000002",
  );
  await client.query(
    "UPDATE thread_goals SET owner_user_id = 'wrong-owner' WHERE id = $1",
    [broken.goalId],
  );
  await expectFailure(() => {
    return applyThrough(true);
  }, /phase=ownership/);
  assert.equal(
    await count(
      "SELECT count(*) FROM thread_goals WHERE retirement_archive_event_id IS NOT NULL",
    ),
    1,
  );
  assert.equal(
    await count(
      "SELECT count(*) FROM drizzle.__drizzle_migrations WHERE created_at = $1",
      [archiveEntry.when],
    ),
    0,
  );
  await client.query(
    "UPDATE thread_goals SET owner_user_id = 'thread-owner' WHERE id = $1",
    [broken.goalId],
  );
  await applyThrough(true);
  assert.equal(
    await count(
      "SELECT count(*) FROM drizzle.__drizzle_migrations WHERE created_at = $1",
      [archiveEntry.when],
    ),
    1,
  );
  await replay();
  assert.equal(
    await count(
      "SELECT count(*) FROM chat_events WHERE event_type = 'output.message'",
    ),
    2,
  );
  assert.equal(
    await count(
      "SELECT count(*) FROM chat_events WHERE event_type = 'goal.close'",
    ),
    2,
  );
  assert.equal(
    await count(
      "SELECT count(*) FROM thread_goals WHERE id = $1 AND status = 'complete'",
      [first.goalId],
    ),
    1,
  );
  console.log(
    "PASS committed prefix, failed journal, recovery and duplicate-free replay",
  );

  // Fail after archive/close/status/receipt were written, proving all roll back.
  await clear();
  const rollback = await seedGoal();
  await appendInput(rollback.threadId, rollback.goalId);
  await client.query(`CREATE FUNCTION goal_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.event_type = 'control.revoke' THEN RAISE EXCEPTION 'sensitive fixture detail'; END IF; RETURN NEW; END; $$;
    CREATE TRIGGER goal_test_failure BEFORE INSERT ON chat_events FOR EACH ROW EXECUTE FUNCTION goal_test_failure()`);
  await expectFailure(replay, /phase=revoke/);
  assert.equal(
    await count(
      "SELECT count(*) FROM thread_goals WHERE status = 'active' AND retirement_archive_event_id IS NULL",
    ),
    1,
  );
  assert.equal(await count("SELECT count(*) FROM chat_events"), 1);
  assert.equal(
    await count(
      "SELECT count(*) FROM chat_threads WHERE last_chat_event_seq_id = 1",
    ),
    1,
  );
  await client.query(
    "DROP TRIGGER goal_test_failure ON chat_events; DROP FUNCTION goal_test_failure()",
  );
  await replay();
  const revoke =
    await client.query(`SELECT r.payload, r.run_id, r.context_type = e.context_type AND r.context_id = e.context_id AS same_context,
    r.chat_thread_id = e.chat_thread_id AS same_thread, r.created_at > e.created_at AS later_time, r.seq_id > e.seq_id AS later_seq
    FROM chat_events r JOIN chat_events e ON r.revokes_event_id = e.id`);
  assert.deepEqual(revoke.rows, [
    {
      payload: null,
      run_id: null,
      same_context: true,
      same_thread: true,
      later_time: true,
      later_seq: true,
    },
  ]);
  console.log(
    "PASS atomic rollback, sanitized errors and canonical revocation",
  );

  await clear();
  const pending = await seedGoal("blocked");
  const ordinaryRun = await seedRun(pending.goalId, "web");
  const original = await appendInput(pending.threadId, pending.goalId);
  await appendInput(pending.threadId, pending.goalId, ordinaryRun, original);
  await appendInput(pending.threadId, pending.goalId, ordinaryRun);
  const reserved = await appendInput(pending.threadId, pending.goalId);
  const deliveryId = randomUUID();
  await client.query(
    "INSERT INTO active_input_deliveries (id, run_id, chat_thread_id) VALUES ($1, $2, $3)",
    [deliveryId, ordinaryRun, pending.threadId],
  );
  await client.query(
    "INSERT INTO active_input_delivery_items (delivery_id, source_event_id, position) VALUES ($1, $2, 0)",
    [deliveryId, reserved],
  );
  await expectFailure(replay, /phase=open reservation/);
  assert.equal(
    await count(
      "SELECT count(*) FROM chat_events WHERE event_type = 'output.message'",
    ),
    0,
  );
  await client.query(
    "UPDATE active_input_delivery_items SET disposition = 'released'; UPDATE active_input_deliveries SET status = 'settled'",
  );
  await replay();
  await replay();
  assert.equal(
    await count(
      "SELECT count(*) FROM chat_events WHERE event_type = 'control.revoke'",
    ),
    1,
  );
  assert.equal(
    await count(
      "SELECT count(*) FROM agent_runs WHERE id = $1 AND status = 'pending' AND goal_id = $2",
      [ordinaryRun, pending.goalId],
    ),
    1,
  );
  assert.equal(
    await count("SELECT count(*) FROM thread_goals WHERE status = 'blocked'"),
    1,
  );
  // More than one revocation unit on a thread with no remaining Goal row.
  const cleared = await seedGoal("paused");
  for (let index = 0; index < 205; index++) {
    await appendInput(cleared.threadId, cleared.goalId);
  }
  await client.query("DELETE FROM thread_goals WHERE id = $1", [
    cleared.goalId,
  ]);
  await replay();
  await assertSettled();
  assert.equal(
    await count(
      "SELECT count(*) FROM chat_events WHERE chat_thread_id = $1 AND event_type = 'control.revoke'",
      [cleared.threadId],
    ),
    205,
  );
  assert.equal(
    await count(
      "SELECT count(*) FROM chat_events WHERE chat_thread_id = $1 AND event_type = 'output.message'",
      [cleared.threadId],
    ),
    0,
  );
  console.log(
    "PASS claimed/revoked/reserved inputs, ordinary run provenance and cleared-thread remainder",
  );

  for (const column of ["org_id", "owner_user_id", "agent_id"] as const) {
    await clear();
    const mismatch = await seedGoal();
    const foreign = await seedGoal();
    await client.query(`UPDATE thread_goals SET ${column} = $1 WHERE id = $2`, [
      column === "agent_id" ? foreign.agentId : "wrong",
      mismatch.goalId,
    ]);
    await expectFailure(replay, /phase=ownership/);
    assert.equal(
      await count(
        "SELECT count(*) FROM chat_events WHERE chat_thread_id = $1",
        [mismatch.threadId],
      ),
      0,
    );
  }
  await clear();
  const own = await seedGoal();
  const foreign = await seedGoal();
  await appendInput(own.threadId, foreign.goalId);
  await expectFailure(replay, /phase=pending context ownership/);
  assert.equal(
    await count(
      "SELECT count(*) FROM chat_events WHERE chat_thread_id = $1 AND event_type = 'control.revoke'",
      [own.threadId],
    ),
    0,
  );
  console.log("PASS Goal and pending-context ownership mismatches");

  for (const lock of ["advisory", "row"] as const) {
    await clear();
    const locked = await seedGoal();
    await other.query("BEGIN");
    if (lock === "advisory") {
      await other.query(
        "SELECT pg_advisory_xact_lock(hashtext('goal:' || $1::text))",
        [locked.threadId],
      );
    } else {
      await other.query(
        "SELECT id FROM chat_threads WHERE id = $1 FOR UPDATE",
        [locked.threadId],
      );
    }
    await expectFailure(replay, /remainder: unarchived=1 active=1/);
    await other.query("COMMIT");
    await replay();
    await assertSettled();
  }
  console.log("PASS advisory/thread lock skips fail completion and recover");

  await clear();
  const race = await seedGoal("active", "00000000-0000-4000-8000-000000000001");
  const toClear = await seedGoal(
    "paused",
    "00000000-0000-4000-8000-000000000002",
  );
  const toCascade = await seedGoal(
    "complete",
    "00000000-0000-4000-8000-000000000003",
  );
  const pidRows = await migration<
    { pid: number }[]
  >`SELECT pg_backend_pid() AS pid`;
  const migrationPid = pidRows[0]!.pid;
  await installBarrier(race.threadId);
  const racingMigration = replay();
  await waitForBlocked(migrationPid);
  const writer = new Client({ connectionString: testUrl.toString() });
  await writer.connect();
  const writerPid = (
    await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
  ).rows[0]!.pid;
  const write = writer.query(
    `WITH reservation AS (
    UPDATE chat_threads SET last_chat_event_seq_id = last_chat_event_seq_id + 1 WHERE id = $1 RETURNING last_chat_event_seq_id
  ) INSERT INTO chat_events (chat_thread_id, event_type, context_type, payload, seq_id)
    SELECT $1, 'input.prompt', 'web', '{"userMessage":{"version":1,"parts":[{"type":"text","text":"continue manually"}]}}', last_chat_event_seq_id FROM reservation`,
    [race.threadId],
  );
  await waitForBlocked(writerPid);
  await client.query("BEGIN");
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext('goal:' || $1::text))",
    [toClear.threadId],
  );
  await client.query("SELECT id FROM chat_threads WHERE id = $1 FOR UPDATE", [
    toClear.threadId,
  ]);
  await client.query("DELETE FROM thread_goals WHERE id = $1", [
    toClear.goalId,
  ]);
  await client.query("DELETE FROM chat_threads WHERE id = $1", [
    toCascade.threadId,
  ]);
  await client.query("COMMIT");
  await other.query("SELECT pg_advisory_unlock(32797, 1)");
  await racingMigration;
  await write;
  await writer.end();
  await removeBarrier();
  assert.equal(
    await count(
      "SELECT count(*) FROM chat_events WHERE chat_thread_id IN ($1, $2)",
      [toClear.threadId, toCascade.threadId],
    ),
    0,
  );
  const sequence = await client.query(
    "SELECT event_type, seq_id FROM chat_events WHERE chat_thread_id = $1 ORDER BY seq_id",
    [race.threadId],
  );
  assert.deepEqual(sequence.rows, [
    { event_type: "output.message", seq_id: "1" },
    { event_type: "goal.close", seq_id: "2" },
    { event_type: "input.prompt", seq_id: "3" },
  ]);
  console.log(
    "PASS ordinary concurrent sequence allocation and stale clear/cascade candidates",
  );

  await clear();
  const late = await seedGoal();
  const beforeRun = await seedRun(late.goalId, "goal");
  await expectFailure(replay, /actual Goal nonterminal=1/);
  assert.equal(await count("SELECT count(*) FROM chat_events"), 0);
  await client.query(
    "UPDATE agent_runs SET status = 'completed' WHERE id = $1",
    [beforeRun],
  );
  await installBarrier(late.threadId);
  const lateMigration = replay();
  // Attach rejection handling before releasing the barrier.
  const lateFailure = expectFailure(() => {
    return lateMigration;
  }, /actual_goal_nonterminal=1/);
  await waitForBlocked(migrationPid);
  const lateRun = await seedRun(null, "goal", "running");
  await other.query("SELECT pg_advisory_unlock(32797, 1)");
  await lateFailure;
  await removeBarrier();
  assert.equal(
    await count(
      "SELECT count(*) FROM agent_runs WHERE id = $1 AND status = 'running'",
      [lateRun],
    ),
    1,
  );
  await client.query(
    "UPDATE agent_runs SET status = 'completed' WHERE id = $1",
    [lateRun],
  );
  await replay();
  console.log(
    "PASS nonterminal preflight and new work at completion without fabricated cancellation",
  );

  // A short CALL timeout after acquiring both locks rolls back the current unit.
  await clear();
  const timeout = await seedGoal();
  await installBarrier(timeout.threadId);
  await migration.unsafe(procedure);
  await migration`SET statement_timeout = '100ms'`;
  await expectFailure(() => {
    return migration`CALL archive_retired_goals_1094()`;
  }, /SQLSTATE=57014/);
  await removeBarrier();
  assert.equal(await count("SELECT count(*) FROM chat_events"), 0);
  await replay();
  console.log("PASS bounded CALL timeout and restart");

  await clear();
  const scaleStart = Date.now();
  // Measured production size, all statuses, with exact objectives kept in SQL.
  await client.query(
    `WITH inserted AS (
    INSERT INTO agents (id, org_id, owner, name)
    SELECT gen_random_uuid(), 'scale-org', 'shared-agent-owner', item::text FROM generate_series(1, 4162) item RETURNING id, name
  ), threads AS (
    INSERT INTO chat_threads (agent_id, user_id) SELECT id, 'scale-owner' FROM inserted RETURNING id, agent_id
  ) INSERT INTO thread_goals (org_id, owner_user_id, agent_id, chat_thread_id, status, objective, objective_brief)
    SELECT 'scale-org', 'scale-owner', t.agent_id, t.id,
      CASE WHEN a.name::int <= 3819 THEN 'complete' WHEN a.name::int <= 3960 THEN 'paused' WHEN a.name::int <= 4160 THEN 'blocked' ELSE 'active' END,
      $1 || repeat('unchanged 🧭 ', 2000) || a.name, 'brief'
    FROM threads t JOIN inserted a ON a.id = t.agent_id`,
    [objective],
  );
  await client.query(
    "CREATE TEMP TABLE original_goals AS SELECT id, objective, status FROM thread_goals",
  );
  const scaleThread = (
    await client.query<{ id: string; goal_id: string }>(
      "SELECT chat_thread_id AS id, id AS goal_id FROM thread_goals LIMIT 1",
    )
  ).rows[0]!;
  // The 103,295 original runless rows already have their canonical revokers.
  await client.query(
    `UPDATE chat_threads SET last_chat_event_seq_id = 206590 WHERE id = $1`,
    [scaleThread.id],
  );
  await client.query(
    `WITH inputs AS (
    INSERT INTO chat_events (chat_thread_id, event_type, context_type, context_id, seq_id, payload, created_at)
    SELECT $1, 'input.goal', 'goal', $2, item, '{"userMessage":{"version":1,"parts":[{"type":"text","text":"old input"}]}}', timestamp '2026-01-01'
    FROM generate_series(1, 103295) item RETURNING id, seq_id
  ) INSERT INTO chat_events (chat_thread_id, event_type, context_type, context_id, seq_id, revokes_event_id, created_at)
    SELECT $1, 'control.revoke', 'goal', $2, seq_id + 103295, id, timestamp '2026-01-02' FROM inputs`,
    [scaleThread.id, scaleThread.goal_id],
  );
  await client.query(
    "ANALYZE thread_goals; ANALYZE chat_events; ANALYZE chat_threads; ANALYZE agent_runs",
  );
  const plan = await client.query<{
    "QUERY PLAN": {
      "Execution Time": number;
      Plan: { "Node Type": string; "Shared Hit Blocks": number };
    }[];
  }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT e.id FROM chat_events e
    WHERE e.event_type = 'input.goal' AND e.run_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM chat_events r WHERE r.revokes_event_id = e.id)`);
  await writeFile(
    join(fixtureDirectory, "pending-plan.json"),
    JSON.stringify(plan.rows),
  );
  const measuredPlan = plan.rows[0]?.["QUERY PLAN"][0];
  assert.ok(measuredPlan);
  console.log(
    `Pending census plan: ${measuredPlan.Plan["Node Type"]}, ${measuredPlan["Execution Time"]}ms, ${measuredPlan.Plan["Shared Hit Blocks"]} shared hit blocks`,
  );
  await replay();
  await assertSettled();
  assert.equal(
    await count(`SELECT count(*) FROM original_goals original JOIN thread_goals goal USING (id)
    JOIN chat_events event ON event.id = goal.retirement_archive_event_id
    WHERE event.chat_thread_id = goal.chat_thread_id AND event.seq_id = goal.retirement_archive_seq_id
      AND event.event_type = 'output.message' AND event.run_id IS NULL
      AND event.payload - 'content' = '{}'::jsonb
      AND right(event.payload->>'content', char_length(original.objective)) = original.objective
      AND position('Original recorded status: ' || original.status IN event.payload->>'content') > 0
      AND goal.status = CASE WHEN original.status = 'active' THEN 'paused' ELSE original.status END`),
    4162,
  );
  assert.equal(
    await count(
      "SELECT count(*) FROM chat_events WHERE event_type = 'goal.close'",
    ),
    4162,
  );
  assert.equal(
    await count(
      "SELECT count(*) FROM chat_events WHERE event_type = 'control.revoke'",
    ),
    103295,
  );
  console.log(
    `PASS 4,162 Goals and 103,295 already-revoked inputs (${Date.now() - scaleStart}ms including seed)`,
  );

  // Validate wire payloads before retaining a whole archive/close pair. The API
  // regression separately drives actual snapshot + tail + export endpoints.
  const archivedThread = (
    await client.query<{ id: string }>(
      "SELECT chat_thread_id AS id FROM thread_goals WHERE chat_thread_id <> $1 LIMIT 1",
      [scaleThread.id],
    )
  ).rows[0]!.id;
  const rows = await client.query(
    `SELECT id, chat_thread_id AS "chatThreadId", run_id AS "runId", revokes_event_id AS "revokesEventId",
    event_type AS "eventType", payload, context_type AS "contextType", context_id AS "contextId",
    run_event_sequence_number AS "runEventSequenceNumber", run_event_id AS "runEventId", seq_id::int AS "seqId",
    to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"
    FROM chat_events WHERE chat_thread_id = $1 ORDER BY seq_id`,
    [archivedThread],
  );
  const snapshot = rows.rows.map((row: unknown) => {
    return chatEventRowSchema.parse(row);
  });
  for (const row of snapshot) {
    chatEventFromRow(row);
  }
  const body = gzipSync(
    snapshot
      .map((row) => {
        return JSON.stringify(row);
      })
      .join("\n") + "\n",
  );
  const key = `chat-events/fixture-${createHash("sha256").update(body).digest("hex")}.ndjson.gz`;
  await writeFile(join(fixtureDirectory, "snapshot.ndjson.gz"), body);
  const last = snapshot.at(-1)!;
  await client.query(
    `INSERT INTO chat_event_snapshots (chat_thread_id, last_seq_id, last_event_id, terminal_seq_id, terminal_event_id, archive_schema_version, object_key)
    VALUES ($1, $2, $3, $2, $3, 7, $4)`,
    [archivedThread, last.seqId, last.id, key],
  );
  await client.query(
    "INSERT INTO chat_event_search_message_watermarks (chat_thread_id, indexed_seq_id) VALUES ($1, $2)",
    [archivedThread, last.seqId],
  );
  await client.query("DELETE FROM chat_events WHERE chat_thread_id = $1", [
    archivedThread,
  ]);
  await replay();
  assert.equal(
    await count("SELECT count(*) FROM chat_events WHERE chat_thread_id = $1", [
      archivedThread,
    ]),
    0,
  );
  assert.equal(
    await count(
      "SELECT count(*) FROM thread_goals WHERE chat_thread_id = $1 AND retirement_archive_event_id IS NOT NULL",
      [archivedThread],
    ),
    1,
  );
  console.log(
    "PASS strict archive contract and receipt survives snapshot/hot deletion without duplicate history",
  );

  for (const values of [
    "NULL, 1",
    "gen_random_uuid(), NULL",
    "gen_random_uuid(), 0",
    "gen_random_uuid(), -1",
    "gen_random_uuid(), 9007199254740992",
  ]) {
    await assert.rejects(
      client.query(
        `UPDATE thread_goals SET (retirement_archive_event_id, retirement_archive_seq_id) = (${values}) WHERE chat_thread_id = $1`,
        [archivedThread],
      ),
      /thread_goals_retirement_archive_receipt_check/,
    );
  }
  assert.ok(
    notices.some((notice) => {
      return notice.includes(
        "unarchived=0 active=0 true_pending=0 reserved=0 actual_goal_nonterminal=0",
      );
    }),
  );
  assert.ok(
    notices.every((notice) => {
      return !notice.includes(objective);
    }),
  );
  console.log(
    "PASS paired receipt constraints and count-only completion evidence",
  );
} finally {
  process.chdir(originalDirectory);
  await other.end();
  await migration.end();
  await client.end();
  await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
  await admin.end();
  await rm(fixtureDirectory, { recursive: true, force: true });
}
