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
import { Client } from "pg";
import postgres from "postgres";
import { chatEventRowSchema } from "@okouai/api-contracts/contracts/chat-event-rows";
import { chatEventFromRow } from "@okouai/api-contracts/contracts/chat-event-row-projection";
import { applyPendingMigrations } from "./migration-runner";

// Historical rows and migration interruption have no public creation API after
// S1. Exercise the real SQL, journal and PostgreSQL locks in a private database.
const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const database = `migration_goal_contract_${randomUUID().replaceAll("-", "")}`;
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
  return entry.tag === "1106_contract_retired_goal_schema";
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

async function replayFull() {
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

async function removeBarrier() {
  await other.query("SELECT pg_advisory_unlock(32797, 1)");
  await client.query(
    "DROP TRIGGER goal_test_barrier ON chat_events; DROP FUNCTION goal_test_barrier()",
  );
}

const gate = statements.find((statement) => {
  return statement.includes("One statement/transaction owns verification");
});
assert.ok(gate);
const prepareSql = await readFile(
  join(directory, "1105_prepare_goal_metadata_contraction.sql"),
  "utf8",
);

async function replayArchive() {
  for (const statement of statements) {
    await migration.unsafe(statement);
    if (statement.trim() === "CALL archive_retired_goals_1106();") break;
  }
}

async function contract() {
  await migration`SET statement_timeout = '10s'`;
  await migration.unsafe(gate!);
}

async function assertPhysicalAvailable() {
  assert.equal(
    await count(
      "SELECT count(*) FROM pg_attribute WHERE attrelid = 'agent_runs'::regclass AND attname = 'goal_id' AND NOT attisdropped",
    ),
    1,
  );
  assert.equal(
    await count(
      "SELECT count(*) FROM pg_constraint WHERE conrelid = 'agent_runs'::regclass AND conname = 'agent_runs_metadata_presence_check' AND convalidated",
    ),
    1,
  );
  assert.equal(
    await count(
      "SELECT count(*) FROM pg_class WHERE oid = to_regclass('public.thread_goals')",
    ),
    1,
  );
}

async function preserveSnapshot(threadId: string, retainHot = false) {
  const rows = await client.query(
    `SELECT id, chat_thread_id AS "chatThreadId", run_id AS "runId", revokes_event_id AS "revokesEventId",
    event_type AS "eventType", payload, context_type AS "contextType", context_id AS "contextId",
    run_event_sequence_number AS "runEventSequenceNumber", run_event_id AS "runEventId", seq_id::int AS "seqId",
    to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt"
    FROM chat_events WHERE chat_thread_id = $1 ORDER BY seq_id`,
    [threadId],
  );
  const snapshot = rows.rows.map((row: unknown) => {
    return chatEventRowSchema.parse(row);
  });
  for (const row of snapshot) chatEventFromRow(row);
  const body = gzipSync(
    snapshot
      .map((row) => {
        return JSON.stringify(row);
      })
      .join("\n") + "\n",
  );
  const last = snapshot.at(-1)!;
  const key = `chat-events/${threadId}/${last.seqId}-r1-${createHash("sha256").update(body).digest("hex")}.ndjson.gz`;
  await client.query(
    `INSERT INTO chat_event_snapshots (chat_thread_id, last_seq_id, last_event_id, terminal_seq_id, terminal_event_id, object_key)
    VALUES ($1, $2, $3, $2, $3, $4)`,
    [threadId, last.seqId, last.id, key],
  );
  await client.query(
    "INSERT INTO chat_event_search_message_watermarks (chat_thread_id, indexed_seq_id) VALUES ($1, $2)",
    [threadId, last.seqId],
  );
  if (!retainHot)
    await client.query("DELETE FROM chat_events WHERE chat_thread_id = $1", [
      threadId,
    ]);
  return key;
}

try {
  await applyThrough(false);
  await assertPhysicalAvailable();
  // Read actual catalog dependencies; automatic check/index deletion must be intentional.
  const dependencies =
    await client.query(`SELECT DISTINCT pg_describe_object(d.classid, d.objid, d.objsubid) AS object
    FROM pg_depend d JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
    WHERE d.refclassid = 'pg_class'::regclass AND a.attrelid = 'agent_runs'::regclass AND a.attname = 'goal_id' ORDER BY object`);
  assert.deepEqual(
    dependencies.rows.map((row: { object: string }) => {
      return row.object;
    }),
    [
      "constraint agent_runs_goal_id_thread_goals_id_fk on table agent_runs",
      "constraint agent_runs_metadata_presence_check on table agent_runs",
      "index idx_agent_runs_goal",
    ],
  );
  console.log("PASS live PostgreSQL Goal column dependency inventory");

  // A committed prefix survives a later ownership failure; replay does not duplicate it.
  const first = await seedGoal(
    "active",
    "00000000-0000-4000-8000-000000000001",
  );
  const second = await seedGoal(
    "blocked",
    "00000000-0000-4000-8000-000000000002",
  );
  await client.query(
    "UPDATE thread_goals SET owner_user_id = 'wrong-owner' WHERE id = $1",
    [second.goalId],
  );
  await expectFailure(() => {
    return applyThrough(true);
  }, /phase=ownership/);
  assert.equal(
    await count(
      "SELECT count(*) FROM drizzle.__drizzle_migrations WHERE created_at = $1",
      [archiveEntry.when],
    ),
    0,
  );
  assert.equal(
    await count(
      "SELECT count(*) FROM thread_goals WHERE retirement_archive_event_id IS NOT NULL",
    ),
    1,
  );
  await assertPhysicalAvailable();
  await client.query(
    "UPDATE thread_goals SET owner_user_id = 'thread-owner' WHERE id = $1",
    [second.goalId],
  );
  await replayArchive();
  await assertSettled();
  assert.equal(
    await count(
      "SELECT count(*) FROM chat_events WHERE event_type = 'output.message'",
    ),
    2,
  );
  // Archived ownership must also be rechecked: it is no longer a replay candidate.
  await client.query(
    "UPDATE thread_goals SET owner_user_id = 'wrong-owner' WHERE id = $1",
    [first.goalId],
  );
  await expectFailure(contract, /phase=residuals and ownership.*invalid=1/);
  await client.query(
    "UPDATE thread_goals SET owner_user_id = 'thread-owner' WHERE id = $1",
    [first.goalId],
  );
  console.log(
    "PASS committed prefix, retry and archived ownership verification",
  );

  // Missing receipts cannot be mistaken for a fresh unarchived objective.
  await client.query(
    "UPDATE thread_goals SET retirement_archive_event_id = NULL, retirement_archive_seq_id = NULL WHERE id = $1",
    [first.goalId],
  );
  await expectFailure(replayFull, /unverifiable missing receipts=1/);
  await clear();
  const bad = await seedGoal("complete");
  await replayArchive();
  await client.query(
    "UPDATE thread_goals SET objective = objective || 'changed' WHERE id = $1",
    [bad.goalId],
  );
  await expectFailure(contract, /phase=literal preservation.*invalid=1/);
  await assertPhysicalAvailable();
  await client.query(
    "UPDATE thread_goals SET objective = $1, status = 'blocked' WHERE id = $2",
    [objective, bad.goalId],
  );
  await expectFailure(contract, /phase=literal preservation.*invalid=1/);
  await clear();
  const missing = await seedGoal("paused");
  await replayArchive();
  await client.query(
    "UPDATE thread_goals SET retirement_archive_event_id = gen_random_uuid() WHERE id = $1",
    [missing.goalId],
  );
  await expectFailure(contract, /phase=literal preservation.*uncovered=1/);
  console.log(
    "PASS missing receipts, exact-content mismatch and missing coverage fail before DROP",
  );

  await clear();
  const retained = await seedGoal("active");
  await replayArchive();
  const validKey = await preserveSnapshot(retained.threadId);
  await replayArchive();
  assert.equal(await count("SELECT count(*) FROM chat_events"), 0);
  for (const key of [
    "chat-events/unknown.ndjson.gz",
    validKey.replace(retained.threadId, randomUUID()),
  ]) {
    await client.query("UPDATE chat_event_snapshots SET object_key = $1", [
      key,
    ]);
    await expectFailure(contract, /phase=literal preservation.*uncovered=1/);
  }
  await client.query(
    "UPDATE chat_event_snapshots SET object_key = $1, terminal_seq_id = NULL",
    [validKey],
  );
  await expectFailure(contract, /phase=literal preservation.*uncovered=1/);
  await client.query(
    "UPDATE chat_event_snapshots SET terminal_seq_id = last_seq_id",
  );
  await assertPhysicalAvailable();
  console.log(
    "PASS snapshot retention without duplicate archive; invalid V7 coverage rejected",
  );

  await clear();
  const pending = await seedGoal("blocked");
  const runId = await seedRun(pending.goalId, "web");
  const input = await appendInput(pending.threadId, pending.goalId);
  const delivery = randomUUID();
  await client.query(
    "INSERT INTO active_input_deliveries (id, run_id, chat_thread_id) VALUES ($1, $2, $3)",
    [delivery, runId, pending.threadId],
  );
  await client.query(
    "INSERT INTO active_input_delivery_items (delivery_id, source_event_id, position) VALUES ($1, $2, 0)",
    [delivery, input],
  );
  await expectFailure(replayFull, /phase=open reservation/);
  await client.query(
    "UPDATE active_input_delivery_items SET disposition = 'released'; UPDATE active_input_deliveries SET status = 'settled'",
  );
  await replayArchive();
  await appendInput(pending.threadId, pending.goalId);
  await expectFailure(contract, /phase=residuals and ownership.*pending=1/);
  await client.query(
    "UPDATE agent_runs SET trigger_source = 'goal' WHERE id = $1",
    [runId],
  );
  await expectFailure(replayFull, /actual Goal nonterminal=1/);
  await client.query(
    "UPDATE agent_runs SET status = 'completed' WHERE id = $1",
    [runId],
  );
  await replayArchive();
  assert.equal(
    await count(
      "SELECT count(*) FROM chat_events WHERE event_type = 'control.revoke'",
    ),
    2,
  );
  assert.equal(
    await count(
      "SELECT count(*) FROM chat_events WHERE event_type = 'output.message'",
    ),
    1,
  );
  console.log(
    "PASS open reservations, late pending work and actual Goal nonterminal gates",
  );

  // Unknown automatic column dependencies and non-catalog-bound function bodies fail closed.
  await client.query(
    "ALTER TABLE agent_runs ADD CONSTRAINT unexpected_goal_check CHECK (goal_id IS NULL OR status <> '')",
  );
  await expectFailure(
    contract,
    /phase=catalog dependencies.*unexpected_dependencies=1/,
  );
  await client.query(
    "ALTER TABLE agent_runs DROP CONSTRAINT unexpected_goal_check",
  );
  await client.query(
    "CREATE FUNCTION unexpected_goal_reader() RETURNS bigint LANGUAGE plpgsql AS $$ BEGIN RETURN (SELECT count(*) FROM thread_goals); END; $$",
  );
  await expectFailure(
    contract,
    /phase=catalog dependencies.*unexpected_dependencies=1/,
  );
  await client.query("DROP FUNCTION unexpected_goal_reader()");
  // RESTRICT catches an external table consumer after attempted column DDL; all of it rolls back.
  await client.query(
    "CREATE VIEW unexpected_goal_view AS SELECT id FROM thread_goals",
  );
  await expectFailure(contract, /phase=physical contraction.*SQLSTATE=2BP01/);
  await assertPhysicalAvailable();
  await client.query("DROP VIEW unexpected_goal_view");
  console.log(
    "PASS unexpected check/function/view dependencies and atomic DDL rollback",
  );

  await other.query("BEGIN; LOCK TABLE chat_events IN ROW EXCLUSIVE MODE");
  const lockStart = Date.now();
  await expectFailure(contract, /phase=lock.*SQLSTATE=55P03/);
  assert.ok(Date.now() - lockStart < 5000);
  await other.query("ROLLBACK");
  await assertPhysicalAvailable();
  // The same lock represents retention DELETE/publication or ordinary event writes.
  await other.query(
    "BEGIN; UPDATE chat_threads SET last_chat_event_seq_id = last_chat_event_seq_id WHERE id = '" +
      pending.threadId +
      "'",
  );
  await expectFailure(contract, /phase=lock.*SQLSTATE=55P03/);
  await other.query("ROLLBACK");
  await migration`SET statement_timeout = '50ms'`;
  await other.query(
    "BEGIN; LOCK TABLE chat_event_snapshots IN ROW EXCLUSIVE MODE",
  );
  await expectFailure(() => {
    return migration.unsafe(gate!);
  }, /phase=lock.*SQLSTATE=57014/);
  await other.query("ROLLBACK");
  await assertPhysicalAvailable();
  console.log(
    "PASS bounded final-lock and statement timeout leave the complete physical schema",
  );

  await clear();
  const timeout = await seedGoal();
  await installBarrier(timeout.threadId);
  await migration.unsafe(procedure);
  await migration`SET statement_timeout = '100ms'`;
  await expectFailure(() => {
    return migration`CALL archive_retired_goals_1106()`;
  }, /SQLSTATE=57014/);
  await removeBarrier();
  assert.equal(await count("SELECT count(*) FROM chat_events"), 0);
  await replayArchive();
  console.log("PASS replay timeout rolls back one thread and safely resumes");

  await clear();
  const scaleStart = Date.now();
  await client.query(
    `WITH inserted AS (
    INSERT INTO agents (id, org_id, owner, name)
    SELECT gen_random_uuid(), 'scale-org', 'shared-agent-owner', item::text FROM generate_series(1, 4162) item RETURNING id, name
  ), threads AS (
    INSERT INTO chat_threads (agent_id, user_id) SELECT id, 'scale-owner' FROM inserted RETURNING id, agent_id
  ) INSERT INTO thread_goals (org_id, owner_user_id, agent_id, chat_thread_id, status, objective, objective_brief)
    SELECT 'scale-org', 'scale-owner', t.agent_id, t.id,
      CASE WHEN a.name::int <= 3819 THEN 'complete' WHEN a.name::int <= 3962 THEN 'paused' ELSE 'blocked' END,
      $1 || repeat('unchanged 🧭 ', 2000) || a.name, 'brief'
    FROM threads t JOIN inserted a ON a.id = t.agent_id`,
    [objective],
  );
  const scale = (
    await client.query<{ thread_id: string; goal_id: string }>(
      "SELECT chat_thread_id AS thread_id, id AS goal_id FROM thread_goals LIMIT 1",
    )
  ).rows[0]!;
  const session = randomUUID();
  await client.query(
    "INSERT INTO agent_sessions (id, user_id, org_id) VALUES ($1, 'scale-owner', 'scale-org')",
    [session],
  );
  await client.query(
    `INSERT INTO agent_runs (session_id, user_id, org_id, prompt, status, trigger_source, autonomy_budget, goal_id)
    SELECT $1, 'scale-owner', 'scale-org', 'retained run',
      CASE WHEN item <= 113394 OR item > 113789 THEN 'completed' WHEN item <= 113541 THEN 'cancelled' WHEN item <= 113785 THEN 'failed' ELSE 'timeout' END,
      CASE WHEN item <= 113789 THEN 'goal' ELSE 'web' END, 1,
      CASE WHEN item <= 113789 THEN $2::uuid END FROM generate_series(1, 271758) item`,
    [session, scale.goal_id],
  );
  await client.query(`INSERT INTO usage_event (run_id, idempotency_key, org_id, user_id, kind, provider, category, quantity, credits_charged, status, processed_at)
    SELECT id, gen_random_uuid(), org_id, user_id, 'model', 'fixture', 'tokens.input', 123, 7, 'processed', now() FROM agent_runs WHERE goal_id IS NOT NULL LIMIT 10`);
  await client.query(`INSERT INTO usage_event_hourly_rollup (run_id, org_id, user_id, kind, provider, category, processed_hour, quantity, credits_charged, allowance_units)
    SELECT id, org_id, user_id, 'model', 'fixture', 'tokens.input', date_trunc('hour', now()), 1234, 70, 0 FROM agent_runs WHERE goal_id IS NOT NULL LIMIT 10`);
  await client.query(`INSERT INTO conversations (run_id, cli_agent_type, cli_agent_session_id, cli_agent_session_history)
    SELECT id, 'codex', id::text, 'retained session history' FROM agent_runs WHERE goal_id IS NOT NULL LIMIT 10`);
  await client.query(`CREATE TEMP TABLE retained_accounting AS
    SELECT 'usage_event' AS relation, id, to_jsonb(u) AS row FROM usage_event u
    UNION ALL SELECT 'usage_event_hourly_rollup', id, to_jsonb(u) FROM usage_event_hourly_rollup u
    UNION ALL SELECT 'conversations', id, to_jsonb(c) FROM conversations c
    UNION ALL SELECT 'agent_sessions', id, to_jsonb(s) FROM agent_sessions s`);
  await client.query(
    "CREATE TEMP TABLE original_runs AS SELECT id, to_jsonb(r) - 'goal_id' AS row FROM agent_runs r",
  );
  await client.query(
    "CREATE TEMP TABLE original_goals AS SELECT * FROM thread_goals",
  );
  await client.query(
    "UPDATE chat_threads SET last_chat_event_seq_id = 203252 WHERE id = $1",
    [scale.thread_id],
  );
  await client.query(
    `WITH inputs AS (
    INSERT INTO chat_events (chat_thread_id, event_type, context_type, context_id, seq_id, payload, created_at)
    SELECT $1, 'input.goal', 'goal', $2, item, '{"userMessage":{"version":1,"parts":[{"type":"text","text":"old input"}]}}', timestamp '2026-01-01'
    FROM generate_series(1, 101626) item RETURNING id, seq_id
  ) INSERT INTO chat_events (chat_thread_id, event_type, context_type, context_id, seq_id, revokes_event_id, created_at)
    SELECT $1, 'control.revoke', 'goal', $2, seq_id + 101626, id, timestamp '2026-01-02' FROM inputs`,
    [scale.thread_id, scale.goal_id],
  );
  await client.query(
    "ANALYZE agent_runs; ANALYZE chat_events; ANALYZE thread_goals; ANALYZE chat_threads",
  );
  // Remeasure the new online constraint on the full cohort. The original
  // validated metadata constraint remains enforced throughout this private test.
  await client.query(
    "ALTER TABLE agent_runs DROP CONSTRAINT agent_runs_metadata_without_goal_check",
  );
  const validationStart = Date.now();
  for (const statement of prepareSql.split("--> statement-breakpoint"))
    await migration.unsafe(statement);
  const validationMs = Date.now() - validationStart;
  const replayStart = Date.now();
  await replayArchive();
  const replayMs = Date.now() - replayStart;
  await assertSettled();
  assert.equal(
    await count(`SELECT count(*) FROM original_goals o JOIN thread_goals g USING (id)
    JOIN chat_events e ON e.id = g.retirement_archive_event_id
    WHERE right(e.payload->>'content', char_length(o.objective)) = o.objective
      AND position('Original recorded status: ' || o.status IN e.payload->>'content') > 0`),
    4162,
  );
  const snapshotThread = (
    await client.query<{ id: string }>(
      "SELECT chat_thread_id AS id FROM thread_goals WHERE chat_thread_id <> $1 LIMIT 1",
      [scale.thread_id],
    )
  ).rows[0]!.id;
  await preserveSnapshot(snapshotThread);
  // Valid committed clear: never resurrect its objective or thread on replay.
  const cleared = await seedGoal("paused");
  await other.query("DELETE FROM chat_threads WHERE id = $1", [
    cleared.threadId,
  ]);
  await replayArchive();
  assert.equal(
    await count("SELECT count(*) FROM chat_events WHERE chat_thread_id = $1", [
      cleared.threadId,
    ]),
    0,
  );
  assert.equal(
    await count(
      "SELECT count(*) FROM chat_events WHERE event_type = 'output.message'",
    ),
    4161,
  );
  await client.query(
    "CREATE TEMP TABLE retained_events AS SELECT id, to_jsonb(e) AS row FROM chat_events e",
  );
  await client.query(
    "CREATE TEMP TABLE retained_snapshots AS SELECT id, to_jsonb(s) AS row FROM chat_event_snapshots s",
  );
  const unrelatedConstraints =
    await client.query(`SELECT conrelid::regclass::text AS relation, conname, pg_get_constraintdef(oid) AS definition, convalidated
    FROM pg_constraint WHERE connamespace = 'public'::regnamespace
      AND conrelid <> 'thread_goals'::regclass
      AND conname NOT IN ('agent_runs_metadata_presence_check', 'agent_runs_metadata_without_goal_check', 'agent_runs_goal_id_thread_goals_id_fk') ORDER BY 1,2`);
  const finalStart = Date.now();
  // Crash after the atomic DDL commit but before helper cleanup/journal INSERT.
  await contract();
  const finalMs = Date.now() - finalStart;
  await applyThrough(true);
  await applyThrough(true);
  const afterConstraints =
    await client.query(`SELECT conrelid::regclass::text AS relation, conname, pg_get_constraintdef(oid) AS definition, convalidated
    FROM pg_constraint WHERE connamespace = 'public'::regnamespace
      AND conname <> 'agent_runs_metadata_presence_check' ORDER BY 1,2`);
  assert.deepEqual(afterConstraints.rows, unrelatedConstraints.rows);
  const accounting = await client.query(`WITH current AS (
    SELECT 'usage_event' AS relation, id, to_jsonb(u) AS row FROM usage_event u
    UNION ALL SELECT 'usage_event_hourly_rollup', id, to_jsonb(u) FROM usage_event_hourly_rollup u
    UNION ALL SELECT 'conversations', id, to_jsonb(c) FROM conversations c
    UNION ALL SELECT 'agent_sessions', id, to_jsonb(s) FROM agent_sessions s
  ) SELECT count(*)::int AS mismatches FROM retained_accounting o FULL JOIN current c USING (relation, id) WHERE o.row IS DISTINCT FROM c.row`);
  assert.deepEqual(accounting.rows, [{ mismatches: 0 }]);
  assert.equal(await count("SELECT count(*) FROM agent_runs"), 271758);
  assert.equal(
    await count(
      "SELECT count(*) FROM original_runs o FULL JOIN agent_runs r USING (id) WHERE o.row IS DISTINCT FROM to_jsonb(r)",
    ),
    0,
  );
  assert.equal(
    await count(
      "SELECT count(*) FROM retained_events o FULL JOIN chat_events e USING (id) WHERE o.row IS DISTINCT FROM to_jsonb(e)",
    ),
    0,
  );
  assert.equal(
    await count(
      "SELECT count(*) FROM retained_snapshots o FULL JOIN chat_event_snapshots s USING (id) WHERE o.row IS DISTINCT FROM to_jsonb(s)",
    ),
    0,
  );
  assert.equal(
    await count(
      "SELECT count(*) FROM pg_attribute WHERE attrelid = 'agent_runs'::regclass AND attname = 'goal_id' AND NOT attisdropped",
    ),
    0,
  );
  assert.equal(
    await count(
      "SELECT count(*) FROM pg_class WHERE relname IN ('thread_goals', 'idx_agent_runs_goal')",
    ),
    0,
  );
  assert.equal(
    await count(
      "SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'archive_retired_goals_%'",
    ),
    0,
  );
  assert.equal(
    await count(
      "SELECT count(*) FROM pg_constraint WHERE conrelid = 'agent_runs'::regclass AND conname IN ('agent_runs_metadata_presence_check', 'agent_runs_autonomy_budget_check') AND convalidated",
    ),
    2,
  );
  assert.equal(
    await count(
      "SELECT count(*) FROM drizzle.__drizzle_migrations WHERE created_at = $1",
      [archiveEntry.when],
    ),
    1,
  );
  assert.ok(
    notices.every((notice) => {
      return !notice.includes(objective);
    }),
  );
  console.log(
    `PASS 4162 Goals / 101626 hot inputs / 113789 linked of 271758 preserved runs: validation=${validationMs}ms replay=${replayMs}ms final=${finalMs}ms total_with_seed=${Date.now() - scaleStart}ms`,
  );
  console.log(
    "PASS journal-gap retry, complete catalog contraction and byte-preserved retained records",
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
