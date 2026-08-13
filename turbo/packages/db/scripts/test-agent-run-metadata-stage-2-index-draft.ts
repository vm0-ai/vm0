import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { applyMigrationsFromDirectoryUpToTag } from "./migration-consistency-helpers";

const expansionMigration = "0919_clammy_mastermind";
const testDatabase = "migration_agent_run_metadata_stage_2_index_draft";

export async function validateAgentRunMetadataStage2IndexDraft(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL is required");
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const migrationsDirectory = path.join(scriptDirectory, "../src/migrations");
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  const testUrl = new URL(databaseUrl);
  testUrl.pathname = `/${testDatabase}`;
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${testDatabase}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${testDatabase}"`);
  const draft = await fs.readFile(
    path.join(scriptDirectory, "agent-run-metadata-stage-2-draft.sql"),
    "utf8",
  );
  const statements = draft
    .split("--> statement-breakpoint")
    .map((statement) => {
      return statement.trim();
    })
    .filter(Boolean);
  const recoveryGuardIndex = statements.findIndex((statement) => {
    return statement.includes("invalid-index recovery artifact");
  });
  const desiredGuardIndex = statements.findIndex((statement) => {
    return statement.includes("Stage 2 index % has a conflicting definition");
  });
  const firstCreateIndex = statements.findIndex((statement) => {
    return statement.startsWith(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_agent_runs_chat_thread_id"',
    );
  });
  assert.ok(recoveryGuardIndex >= 0);
  assert.ok(desiredGuardIndex > recoveryGuardIndex);
  assert.ok(firstCreateIndex > desiredGuardIndex);
  const desiredGuard = statements[desiredGuardIndex]!;
  const indexPhase = statements.slice(recoveryGuardIndex, firstCreateIndex + 3);
  const constraintGuardIndex = statements.findIndex((statement) => {
    return statement.includes(
      "Stage 2 constraint % has a conflicting definition",
    );
  });
  const finalValidationBeginIndex = statements.findIndex((statement, index) => {
    return (
      index > constraintGuardIndex &&
      statement ===
        "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;"
    );
  });
  assert.ok(constraintGuardIndex > firstCreateIndex);
  assert.ok(finalValidationBeginIndex > constraintGuardIndex);
  const constraintPhase = statements.slice(
    constraintGuardIndex,
    finalValidationBeginIndex,
  );

  async function connect(): Promise<Client> {
    const client = new Client({ connectionString: testUrl.toString() });
    await client.connect();
    return client;
  }

  async function runIndexPhase(client: Client): Promise<void> {
    for (const statement of indexPhase) {
      await client.query(statement);
    }
  }

  async function runConstraintPhase(client: Client): Promise<void> {
    for (const statement of constraintPhase) {
      await client.query(statement);
    }
  }

  async function readArtifact(
    client: Client,
    name: string,
  ): Promise<
    { definition: string; ready: boolean; valid: boolean } | undefined
  > {
    const result = await client.query<{
      definition: string;
      ready: boolean;
      valid: boolean;
    }>(
      `
        SELECT
          pg_get_indexdef("index_class"."oid") AS "definition",
          "index_row"."indisready" AS "ready",
          "index_row"."indisvalid" AS "valid"
        FROM "pg_class" AS "index_class"
        INNER JOIN "pg_namespace" AS "index_namespace"
          ON "index_namespace"."oid" = "index_class"."relnamespace"
        INNER JOIN "pg_index" AS "index_row"
          ON "index_row"."indexrelid" = "index_class"."oid"
        WHERE "index_namespace"."nspname" = 'public'
          AND "index_class"."relname" = $1
      `,
      [name],
    );
    return result.rows[0];
  }

  async function leaveInvalidDesiredIndex(): Promise<void> {
    const blocker = await connect();
    const builder = await connect();
    const observer = await connect();
    try {
      await observer.query(
        'DROP INDEX CONCURRENTLY IF EXISTS "idx_agent_runs_chat_thread_id"',
      );
      await blocker.query("BEGIN");
      await blocker.query(`
        UPDATE "agent_runs"
        SET "prompt" = "prompt"
        WHERE "id" = (
          SELECT "id" FROM "agent_runs"
          WHERE "user_id" = 'stage2-lock-probe-user'
          LIMIT 1
        )
      `);
      const pid = await builder.query<{ pid: number }>(
        `SELECT pg_backend_pid() AS "pid"`,
      );
      const build = builder
        .query(
          `
          CREATE INDEX CONCURRENTLY "idx_agent_runs_chat_thread_id"
          ON "agent_runs" USING btree ("chat_thread_id")
          WHERE "chat_thread_id" IS NOT NULL
        `,
        )
        .then(
          () => {
            return { error: undefined };
          },
          (error: unknown) => {
            return { error };
          },
        );

      let artifact:
        | { definition: string; ready: boolean; valid: boolean }
        | undefined;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        artifact = await readArtifact(
          observer,
          "idx_agent_runs_chat_thread_id",
        );
        if (artifact) break;
        await new Promise((resolve) => {
          return setTimeout(resolve, 10);
        });
      }
      assert.ok(artifact);
      assert.equal(artifact.valid, false);
      const cancelled = await observer.query<{ cancelled: boolean }>(
        `SELECT pg_cancel_backend($1) AS "cancelled"`,
        [pid.rows[0]!.pid],
      );
      assert.equal(cancelled.rows[0]?.cancelled, true);
      const buildResult = await build;
      assert.ok(buildResult.error);
      await blocker.query("ROLLBACK");

      artifact = await readArtifact(observer, "idx_agent_runs_chat_thread_id");
      assert.deepEqual(artifact, {
        definition:
          "CREATE INDEX idx_agent_runs_chat_thread_id ON public.agent_runs USING btree (chat_thread_id) WHERE (chat_thread_id IS NOT NULL)",
        ready: false,
        valid: false,
      });
    } finally {
      await blocker.query("ROLLBACK").catch(() => {
        return undefined;
      });
      await blocker.end();
      await builder.end();
      await observer.end();
    }
  }

  const client = await connect();
  await applyMigrationsFromDirectoryUpToTag(
    client,
    migrationsDirectory,
    expansionMigration,
  );
  try {
    await leaveInvalidDesiredIndex();
    await client.query(desiredGuard);
    assert.deepEqual(
      await readArtifact(
        client,
        "idx_agent_runs_chat_thread_id_stage2_invalid",
      ),
      {
        definition:
          "CREATE INDEX idx_agent_runs_chat_thread_id_stage2_invalid ON public.agent_runs USING btree (chat_thread_id) WHERE (chat_thread_id IS NOT NULL)",
        ready: false,
        valid: false,
      },
    );
    assert.equal(
      await readArtifact(client, "idx_agent_runs_chat_thread_id"),
      undefined,
    );
    await runIndexPhase(client);
    assert.deepEqual(
      await readArtifact(client, "idx_agent_runs_chat_thread_id"),
      {
        definition:
          "CREATE INDEX idx_agent_runs_chat_thread_id ON public.agent_runs USING btree (chat_thread_id) WHERE (chat_thread_id IS NOT NULL)",
        ready: true,
        valid: true,
      },
    );
    assert.equal(
      await readArtifact(
        client,
        "idx_agent_runs_chat_thread_id_stage2_invalid",
      ),
      undefined,
    );

    await client.query(`
      CREATE INDEX "idx_agent_runs_chat_thread_id_stage2_invalid"
      ON "agent_runs" ("id")
    `);
    await assert.rejects(
      runIndexPhase(client),
      /invalid-index recovery artifact idx_agent_runs_chat_thread_id_stage2_invalid has conflicting definition or state/,
    );
    assert.ok(
      await readArtifact(
        client,
        "idx_agent_runs_chat_thread_id_stage2_invalid",
      ),
    );
    await client.query(
      'DROP INDEX "idx_agent_runs_chat_thread_id_stage2_invalid"',
    );

    await client.query('DROP INDEX "idx_agent_runs_chat_thread_id"');
    await client.query(`
      CREATE INDEX "idx_agent_runs_chat_thread_id"
      ON "agent_runs" ("id")
    `);
    await assert.rejects(
      runIndexPhase(client),
      /Stage 2 index idx_agent_runs_chat_thread_id has a conflicting definition/,
    );
    assert.match(
      (await readArtifact(client, "idx_agent_runs_chat_thread_id"))!.definition,
      /\(id\)$/,
    );
    await client.query('DROP INDEX "idx_agent_runs_chat_thread_id"');
    await runIndexPhase(client);
    assert.equal(
      await readArtifact(
        client,
        "idx_agent_runs_chat_thread_id_stage2_invalid",
      ),
      undefined,
    );

    await runConstraintPhase(client);
    await client.query(`
      ALTER TABLE "agent_runs"
      DROP CONSTRAINT "agent_runs_chat_thread_id_chat_threads_id_fk"
    `);
    await client.query(`
      ALTER TABLE "agent_runs"
      ADD CONSTRAINT "agent_runs_chat_thread_id_chat_threads_id_fk"
      CHECK ("chat_thread_id" IS NULL) NOT VALID
    `);
    await assert.rejects(
      runConstraintPhase(client),
      /Stage 2 constraint agent_runs_chat_thread_id_chat_threads_id_fk has a conflicting definition/,
    );
    const wrongConstraint = await client.query<{
      definition: string;
      validated: boolean;
    }>(`
      SELECT
        pg_get_constraintdef("oid", true) AS "definition",
        "convalidated" AS "validated"
      FROM "pg_constraint"
      WHERE "conrelid" = 'public.agent_runs'::regclass
        AND "conname" = 'agent_runs_chat_thread_id_chat_threads_id_fk'
    `);
    assert.deepEqual(wrongConstraint.rows, [
      {
        definition: "CHECK (chat_thread_id IS NULL) NOT VALID",
        validated: false,
      },
    ]);
    await client.query(`
      ALTER TABLE "agent_runs"
      DROP CONSTRAINT "agent_runs_chat_thread_id_chat_threads_id_fk"
    `);
    await runConstraintPhase(client);
  } finally {
    await client.end();
    await admin.query(`DROP DATABASE IF EXISTS "${testDatabase}" WITH (FORCE)`);
    await admin.end();
  }

  console.log("stage2 index probe passed");
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  validateAgentRunMetadataStage2IndexDraft().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
