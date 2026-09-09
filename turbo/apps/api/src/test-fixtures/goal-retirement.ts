import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { env } from "../lib/env";
import { visiblePiMemoryCitationText } from "@okouai/api-contracts/contracts/pi-memory-citations";
import { chatSearchIndexText } from "../lib/chat-search-bigram";
import {
  recoverGoalArchiveSearch,
  type SnapshotLoader,
} from "@okouai/db/migrations/014-goal-archive-search";

/**
 * Only historical infrastructure can construct these rows after S1. Temporary
 * updatable views restrict the unchanged migration to this test-owned thread;
 * the DB transition suite separately exercises its unfiltered global census.
 */
async function withGoalRetirementFixture(
  threadId: string,
  work: (client: Client) => Promise<void>,
): Promise<void> {
  const client = new Client({ connectionString: env("DATABASE_URL") });
  const runFixture = async () => {
    await client.connect();
    await client.query(
      "SELECT set_config('test.goal_retirement_thread', $1, false)",
      [threadId],
    );
    await client.query(`
      CREATE TEMP VIEW chat_threads AS SELECT * FROM public.chat_threads WHERE id = current_setting('test.goal_retirement_thread')::uuid;
      CREATE TEMP VIEW thread_goals AS SELECT * FROM public.thread_goals WHERE chat_thread_id = current_setting('test.goal_retirement_thread')::uuid;
      CREATE TEMP VIEW chat_events AS SELECT * FROM public.chat_events WHERE chat_thread_id = current_setting('test.goal_retirement_thread')::uuid;
      CREATE TEMP VIEW agents AS SELECT * FROM public.agents WHERE id IN (SELECT agent_id FROM pg_temp.chat_threads);
      CREATE TEMP VIEW agent_runs AS SELECT * FROM public.agent_runs WHERE chat_thread_id = current_setting('test.goal_retirement_thread')::uuid;
      CREATE TEMP VIEW active_input_deliveries AS SELECT * FROM public.active_input_deliveries WHERE chat_thread_id = current_setting('test.goal_retirement_thread')::uuid;
      CREATE TEMP VIEW active_input_delivery_items AS SELECT * FROM public.active_input_delivery_items WHERE source_event_id IN (SELECT id FROM pg_temp.chat_events);
      SET search_path TO pg_temp, public;
    `);
    await work(client);
  };
  const [result] = await Promise.allSettled([runFixture()]);
  await client.end();
  if (result.status === "rejected") {
    throw result.reason;
  }
}

export async function seedGoalRetirementHistory(
  threadId: string,
  objective: string,
  status: "active" | "paused" | "blocked" | "complete" = "active",
): Promise<void> {
  await withGoalRetirementFixture(threadId, async (client) => {
    await client.query(
      `INSERT INTO thread_goals (org_id, owner_user_id, agent_id, chat_thread_id, status, objective, objective_brief)
      SELECT agent.org_id, thread.user_id, agent.id, thread.id, $2, $1, 'historical brief'
      FROM chat_threads thread JOIN agents agent ON agent.id = thread.agent_id`,
      [objective, status],
    );
    await client.query(`WITH reservation AS (
      UPDATE chat_threads SET last_chat_event_seq_id = last_chat_event_seq_id + 1 RETURNING id, last_chat_event_seq_id
    ) INSERT INTO chat_events (chat_thread_id, event_type, payload, seq_id)
      SELECT id, 'goal.open', '{"content":"historical brief"}', last_chat_event_seq_id FROM reservation`);
  });
}

export async function applyGoalRetirementFixture(
  threadId: string,
): Promise<void> {
  const source = await readFile(
    new URL(
      "../../../../packages/db/src/migrations/1094_archive_retired_goals.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await withGoalRetirementFixture(threadId, async (client) => {
    // Only the procedure namespace changes; preserve its complete SQL behavior.
    for (const statement of source
      .replaceAll(
        "archive_retired_goals_1094",
        "pg_temp.archive_retired_goals_1094",
      )
      .split("--> statement-breakpoint")) {
      if (statement.trim()) {
        await client.query(statement);
      }
    }
  });
}

export async function removeSnapshottedGoalFixtureEvents(
  threadId: string,
): Promise<void> {
  await withGoalRetirementFixture(threadId, async (client) => {
    // Simulate the later retention deletion after real snapshot/search
    // publication, without changing immutable timestamps or any trigger.
    await client.query(`DELETE FROM chat_events event USING public.chat_event_snapshots snapshot, public.chat_event_search_message_watermarks watermark
      WHERE event.chat_thread_id = snapshot.chat_thread_id AND event.chat_thread_id = watermark.chat_thread_id
        AND snapshot.archive_schema_version = 7 AND snapshot.last_seq_id >= event.seq_id
        AND watermark.indexed_seq_id >= event.seq_id`);
  });
}

/** Old API materialization cannot be requested after the reader is repaired. */
export async function seedFilteredGoalArchiveProjections(
  threadId: string,
): Promise<string> {
  let shareId: string | undefined;
  await withGoalRetirementFixture(threadId, async (client) => {
    const result = await client.query<
      Record<string, unknown>
    >(`SELECT event.payload->>'content' AS content, event.seq_id,
      event.created_at, thread.user_id, agent.id AS agent_id, agent.org_id
      FROM thread_goals goal JOIN chat_events event ON event.id = goal.retirement_archive_event_id
      JOIN chat_threads thread ON thread.id = event.chat_thread_id JOIN agents agent ON agent.id = thread.agent_id`);
    const row = result.rows[0];
    if (!row || typeof row.content !== "string") {
      throw new Error("Expected archive fixture");
    }
    const filtered = visiblePiMemoryCitationText(row.content).trim();
    await client.query(
      `INSERT INTO chat_event_search_messages
      (chat_thread_id, seq_id, run_id, user_id, org_id, agent_id, role, created_at, text, text_bigram)
      VALUES ($1, $2, NULL, $3, $4, $5, 'assistant', $6, $7, $8)
      ON CONFLICT (chat_thread_id, seq_id) DO UPDATE SET text = EXCLUDED.text, text_bigram = EXCLUDED.text_bigram`,
      [
        threadId,
        row.seq_id,
        row.user_id,
        row.org_id,
        row.agent_id,
        row.created_at,
        filtered,
        chatSearchIndexText(filtered),
      ],
    );
    await client.query(`INSERT INTO chat_event_search_message_watermarks (chat_thread_id, indexed_seq_id)
      SELECT id, last_chat_event_seq_id FROM chat_threads
      ON CONFLICT (chat_thread_id) DO UPDATE SET indexed_seq_id = EXCLUDED.indexed_seq_id`);
    const share = await client.query<Record<string, unknown>>(
      `INSERT INTO shared_threads (user_id, source_chat_thread_id, title, messages)
      VALUES ($1, $2, 'Historical public copy', $3) RETURNING id`,
      [
        row.user_id,
        threadId,
        JSON.stringify([
          { messageIndex: 0, role: "assistant", content: filtered },
        ]),
      ],
    );
    if (typeof share.rows[0]?.id !== "string") {
      throw new Error("Expected historical share");
    }
    shareId = share.rows[0].id;
  });
  if (shareId === undefined) {
    throw new Error("Expected historical share ID");
  }
  return shareId;
}

/** Runs the one-off repair against test-owned history; no new product endpoint. */
export async function recoverGoalArchiveSearchFixture(
  threadId: string,
  loadSnapshot: SnapshotLoader,
  migrate: boolean,
): Promise<void> {
  await withGoalRetirementFixture(threadId, async (client) => {
    await recoverGoalArchiveSearch(client, threadId, loadSnapshot, migrate);
  });
}

/** Current writers cannot produce extra payload keys on assistant output. */
export async function seedMalformedGoalArchiveFixture(
  threadId: string,
  content: string,
): Promise<string> {
  let eventId: string | undefined;
  await withGoalRetirementFixture(threadId, async (client) => {
    const payload = Object.fromEntries([
      ["content", content],
      ["__proto__", "historical extra key"],
    ]);
    const rows = await client.query<Record<string, unknown>>(
      `WITH reservation AS (
        UPDATE chat_threads SET last_chat_event_seq_id = last_chat_event_seq_id + 1
        RETURNING id, last_chat_event_seq_id
      ) INSERT INTO chat_events (chat_thread_id, event_type, seq_id, payload)
      SELECT id, 'output.message', last_chat_event_seq_id, $1 FROM reservation RETURNING id`,
      [JSON.stringify(payload)],
    );
    if (typeof rows.rows[0]?.id !== "string") {
      throw new Error("Expected malformed historical event ID");
    }
    eventId = rows.rows[0].id;
  });
  if (eventId === undefined) {
    throw new Error("Expected malformed historical event ID");
  }
  return eventId;
}
