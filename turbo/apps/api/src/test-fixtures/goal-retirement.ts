import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { env } from "../lib/env";

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
): Promise<void> {
  await withGoalRetirementFixture(threadId, async (client) => {
    await client.query(
      `INSERT INTO thread_goals (org_id, owner_user_id, agent_id, chat_thread_id, status, objective, objective_brief)
      SELECT agent.org_id, thread.user_id, agent.id, thread.id, 'active', $1, 'historical brief'
      FROM chat_threads thread JOIN agents agent ON agent.id = thread.agent_id`,
      [objective],
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
