#!/usr/bin/env tsx
import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import {
  CertificateError,
  certifyRecovery,
  parseMode,
  type Mode,
} from "./certificate";

// One metadata-only statement gives the complete inventory and retirement
// prerequisites one PostgreSQL snapshot. No receipt filter or cursor can shrink it.
export const inventorySql = `
SELECT count(*)::text AS goals,
  count(DISTINCT chat_thread_id)::text AS threads,
  count(*) FILTER (WHERE retirement_archive_event_id IS NOT NULL
    AND retirement_archive_seq_id > 0
    AND retirement_archive_seq_id <= 9007199254740991)::text AS receipts,
  count(*) FILTER (WHERE status = 'active')::text AS active,
  count(*) FILTER (WHERE status = 'complete')::text AS complete,
  count(*) FILTER (WHERE status = 'paused')::text AS paused,
  count(*) FILTER (WHERE status = 'blocked')::text AS blocked,
  encode(sha256(convert_to(coalesce(string_agg(id::text, E'\\n'
    ORDER BY id::text COLLATE "C"), '') || E'\\n', 'UTF8')), 'hex') AS hash,
  (SELECT count(*)::text FROM agent_runs
    WHERE trigger_source = 'goal' AND status IN ('queued', 'pending', 'running')) AS nonterminal,
  (SELECT count(*)::text FROM chat_events event
    WHERE event.event_type = 'input.goal' AND event.run_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM chat_events revoker
        WHERE revoker.revokes_event_id = event.id)) AS pending
FROM thread_goals`;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error("missing_configuration");
  return value;
}

async function readCohort(): Promise<unknown> {
  const client = new Client({
    connectionString: required("DATABASE_URL"),
    connectionTimeoutMillis: 30_000,
  });
  // Never allow pg notice/error payloads into runner logs.
  let connectionFailed = false;
  client.on("notice", () => {});
  client.on("error", () => {
    connectionFailed = true;
  });
  try {
    await client.connect();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query("SET LOCAL lock_timeout = '1s'");
    const result = await client.query<Record<string, unknown>>(inventorySql);
    if (result.rows.length !== 1) throw new CertificateError("invalid_cohort");
    await client.query("COMMIT");
    if (connectionFailed) throw new CertificateError("invalid_cohort");
    return result.rows[0];
  } finally {
    await client.end();
  }
}

function runOperation(mode: Mode) {
  const script = fileURLToPath(
    new URL(
      "../migrations/014-goal-archive-search/backfill.ts",
      import.meta.url,
    ),
  );
  // No shell, resume arguments, or source override. A fresh process always
  // starts the unchanged engine at its default complete inventory.
  return new Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
  }>((resolve) => {
    execFile(
      process.execPath,
      ["--import", "tsx", script, ...(mode === "apply" ? ["--migrate"] : [])],
      {
        maxBuffer: 1024 * 1024,
        env: {
          DATABASE_URL: required("DATABASE_URL"),
          R2_ACCOUNT_ID: required("R2_ACCOUNT_ID"),
          R2_ACCESS_KEY_ID: required("R2_ACCESS_KEY_ID"),
          R2_SECRET_ACCESS_KEY: required("R2_SECRET_ACCESS_KEY"),
          R2_USER_STORAGES_BUCKET_NAME: required(
            "R2_USER_STORAGES_BUCKET_NAME",
          ),
        },
      },
      (error, stdout, stderr) => {
        // execFile errors embed captured provider output: never return them.
        resolve({ stdout, stderr, exitCode: error ? 1 : 0 });
      },
    );
  });
}

async function main(): Promise<void> {
  const mode = parseMode(process.argv.slice(2));
  const source = required("GITHUB_SHA");
  const runId = required("GITHUB_RUN_ID");
  const attempt = required("GITHUB_RUN_ATTEMPT");
  if (
    required("GITHUB_EVENT_NAME") !== "workflow_dispatch" ||
    required("GITHUB_REF") !== "refs/heads/main" ||
    required("GITHUB_REPOSITORY") !== "vm0-ai/vm0" ||
    !/^[0-9a-f]{40}$/u.test(source) ||
    !/^[0-9]+$/u.test(runId) ||
    !/^[0-9]+$/u.test(attempt)
  )
    throw new Error("invalid_run_identity");
  const uri = new URL(required("DATABASE_URL"));
  if (uri.searchParams.get("sslmode") !== "verify-full")
    throw new Error("invalid_database_tls");
  const success = await certifyRecovery(mode, {
    readCohort,
    runOperation,
    emit: (record) => {
      const line = JSON.stringify({ source, runId, attempt, ...record });
      console.log(line);
      appendFileSync(required("GITHUB_STEP_SUMMARY"), `\n\`${line}\`\n`);
    },
  });
  if (!success) process.exitCode = 1;
}

// Imports used by synthetic tests do not execute the protected entry point.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error(
      JSON.stringify({ complete: false, errorClass: "entry_failed" }),
    );
    process.exitCode = 1;
  });
}
