#!/usr/bin/env tsx

/**
 * Backfill selected-model chat thread events.
 *
 * Usage (from turbo/packages/db):
 *   pnpm exec tsx scripts/migrations/009-chat-thread-selected-model-events/backfill.ts
 *   pnpm exec tsx scripts/migrations/009-chat-thread-selected-model-events/backfill.ts --migrate
 *
 * Environment:
 *   DATABASE_URL — Required
 */

import { parseArgs } from "node:util";
import postgres from "postgres";

const { values: args } = parseArgs({
  options: {
    migrate: { type: "boolean", default: false },
  },
  strict: true,
});

const DRY_RUN = !args.migrate;

async function countCandidates(sql: postgres.Sql): Promise<number> {
  const rows = await sql`
    SELECT COUNT(*)::int AS candidate_count
    FROM chat_threads ct
    INNER JOIN agent_composes ac ON ac.id = ct.agent_compose_id
    WHERE ct.selected_model IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM chat_thread_events existing
        WHERE existing.chat_thread_id = ct.id
          AND existing.kind = 'model_selection_updated'::chat_thread_event_kind
          AND existing.selected_model = ct.selected_model
      )
  `;

  return Number(rows[0]?.candidate_count ?? 0);
}

async function insertBackfillEvents(sql: postgres.Sql): Promise<number> {
  const rows = await sql`
    WITH inserted AS (
      INSERT INTO chat_thread_events (
        user_id,
        org_id,
        chat_thread_id,
        kind,
        agent_compose_id,
        title,
        selected_model,
        created_at
      )
      SELECT
        ct.user_id,
        ac.org_id,
        ct.id,
        'model_selection_updated'::chat_thread_event_kind,
        ct.agent_compose_id,
        NULL,
        ct.selected_model,
        NOW()
      FROM chat_threads ct
      INNER JOIN agent_composes ac ON ac.id = ct.agent_compose_id
      WHERE ct.selected_model IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM chat_thread_events existing
          WHERE existing.chat_thread_id = ct.id
            AND existing.kind = 'model_selection_updated'::chat_thread_event_kind
            AND existing.selected_model = ct.selected_model
        )
      RETURNING id
    )
    SELECT COUNT(*)::int AS inserted_count
    FROM inserted
  `;

  return Number(rows[0]?.inserted_count ?? 0);
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const sql = postgres(databaseUrl, { max: 1 });

  try {
    console.log("=== Backfill Chat Thread Selected Model Events ===");
    console.log(
      `Mode: ${DRY_RUN ? "dry-run (pass --migrate to execute)" : "MIGRATE"}`,
    );

    const candidateCount = await countCandidates(sql);
    console.log(`Candidate thread(s): ${candidateCount}`);

    if (DRY_RUN || candidateCount === 0) {
      return;
    }

    const insertedCount = await insertBackfillEvents(sql);
    console.log(`Inserted event(s): ${insertedCount}`);
  } finally {
    await sql.end();
  }
}

await main();
