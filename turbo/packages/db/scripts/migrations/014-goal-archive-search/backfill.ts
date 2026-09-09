#!/usr/bin/env tsx
import { parseArgs } from "node:util";
import { Client } from "pg";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { recoverGoalArchiveSearch, type RecoveryOutcome } from "./recover";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error("missing_configuration");
  return value;
}
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      migrate: { type: "boolean", default: false },
      "max-threads": { type: "string", default: "5000" },
      "after-thread": { type: "string" },
    },
    strict: true,
  });
  const limit = Number(values["max-threads"]);
  if (!Number.isInteger(limit) || limit < 1 || limit > 5000)
    throw new Error("invalid_limit");
  let cursor = values["after-thread"] ?? null;
  if (cursor !== null && !/^[0-9a-f-]{36}$/u.test(cursor))
    throw new Error("invalid_cursor");
  const client = new Client({ connectionString: requiredEnv("DATABASE_URL") });
  const s3 = new S3Client({
    region: "auto",
    endpoint: `https://${requiredEnv("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: requiredEnv("R2_ACCESS_KEY_ID"),
      secretAccessKey: requiredEnv("R2_SECRET_ACCESS_KEY"),
    },
  });
  const bucket = requiredEnv("R2_USER_STORAGES_BUCKET_NAME");
  const counts: Record<RecoveryOutcome, number> = {
    unchanged: 0,
    repairable: 0,
    repaired: 0,
    "not-indexed": 0,
    revoked: 0,
    deleted: 0,
  };
  let processed = 0;
  let complete = false;
  try {
    await client.connect();
    if (!values.migrate)
      await client.query("SET default_transaction_read_only = on");
    await client.query("SET statement_timeout = '10s'");
    while (processed < limit) {
      const page = await client.query<Record<string, unknown>>(
        `SELECT chat_thread_id FROM thread_goals
        WHERE retirement_archive_event_id IS NOT NULL AND ($1::uuid IS NULL OR chat_thread_id > $1)
        ORDER BY chat_thread_id LIMIT $2`,
        [cursor, Math.min(100, limit - processed)],
      );
      if (page.rows.length === 0) {
        complete = true;
        break;
      }
      for (const row of page.rows) {
        if (typeof row.chat_thread_id !== "string")
          throw new Error("invalid_thread_id");
        const outcome = await recoverGoalArchiveSearch(
          client,
          row.chat_thread_id,
          async (key) => {
            const object = await s3.send(
              new GetObjectCommand({ Bucket: bucket, Key: key }),
              { abortSignal: AbortSignal.timeout(30_000) },
            );
            if (!object.Body) throw new Error("missing_snapshot_body");
            return Buffer.from(await object.Body.transformToByteArray());
          },
          values.migrate,
        );
        counts[outcome] += 1;
        processed += 1;
        cursor = row.chat_thread_id;
      }
      console.log(
        JSON.stringify({
          mode: values.migrate ? "migrate" : "dry-run",
          processed,
          counts,
          cursor,
          complete: false,
        }),
      );
    }
    if (!complete) {
      const remainder = await client.query(
        "SELECT 1 FROM thread_goals WHERE retirement_archive_event_id IS NOT NULL AND chat_thread_id > $1 LIMIT 1",
        [cursor],
      );
      complete = remainder.rows.length === 0;
    }
    console.log(
      JSON.stringify({
        mode: values.migrate ? "migrate" : "dry-run",
        processed,
        counts,
        cursor,
        complete,
      }),
    );
  } finally {
    await client.end();
    s3.destroy();
  }
}
// Provider/SQL/validation errors may carry historical content. Never print them.
main().catch(() => {
  console.error(
    "Goal archive search recovery failed; retain the last completed cursor and investigate privately.",
  );
  process.exitCode = 1;
});
