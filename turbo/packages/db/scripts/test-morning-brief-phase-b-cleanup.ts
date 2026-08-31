import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { userMessageDocumentSchema } from "@okouai/api-contracts/contracts/chat-threads";
import { Client } from "pg";

import { applyMigrationsFromDirectoryUpToTag } from "./migration-consistency-helpers";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.join(scriptDirectory, "../src/migrations");
const previousMigration =
  "1034_org_metadata_acquisition_first_party_source_backfill";
export const MORNING_BRIEF_PHASE_B_MIGRATION =
  "1035_morning_brief_phase_b_cleanup";
const testDatabase = "migration_morning_brief_phase_b_30369";

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

function fixtureUuid(id: number): string {
  return `00000000-0000-4000-8000-${id.toString().padStart(12, "0")}`;
}

interface HistoricalShape {
  readonly index: number;
  readonly title: string;
  readonly briefDate: string;
  readonly parts: readonly Record<string, unknown>[];
  readonly runStatus?: "completed" | "failed" | "cancelled";
  readonly deliveryStatus: "emailed" | "failed";
}

const historicalShapes: readonly HistoricalShape[] = [
  {
    index: 1,
    title: "Morning Brief text history",
    briefDate: "2026-08-20",
    parts: [{ type: "text", text: "Summarize today's priorities." }],
    runStatus: "completed",
    deliveryStatus: "emailed",
  },
  {
    index: 2,
    title: "Morning Brief file history",
    briefDate: "2026-08-21",
    parts: [
      {
        type: "file",
        fileId: "historical-file",
        filenameSnapshot: "priorities.pdf",
        contentType: "application/pdf",
      },
      { type: "text", text: "Include the attached priorities." },
    ],
    runStatus: "failed",
    deliveryStatus: "failed",
  },
  {
    index: 3,
    title: "Morning Brief thread history",
    briefDate: "2026-08-22",
    parts: [
      {
        type: "chat_thread",
        threadId: fixtureUuid(103),
        titleSnapshot: "Launch planning",
      },
      { type: "text", text: "Carry forward the launch decisions." },
    ],
    runStatus: "completed",
    deliveryStatus: "emailed",
  },
  {
    index: 4,
    title: "Morning Brief template history",
    briefDate: "2026-08-23",
    parts: [
      {
        type: "template",
        titleSnapshot: "Editorial illustration",
        template: {
          type: "illustration",
          selection: { illustrationStyleId: "editorial" },
        },
      },
      { type: "text", text: "Illustrate the highest-priority update." },
    ],
    runStatus: "cancelled",
    deliveryStatus: "failed",
  },
  {
    index: 5,
    title: "Morning Brief terminal rejection history",
    briefDate: "2026-08-24",
    parts: [
      {
        type: "feedback",
        quote: "The owner is still unclear.",
        note: [{ type: "text", text: "Name the owner." }],
      },
      { type: "text", text: "Finish the ownership summary." },
    ],
    deliveryStatus: "failed",
  },
];

interface HistoricalEventSnapshot {
  readonly id: string;
  readonly chatThreadId: string;
  readonly runId: string | null;
  readonly revokesEventId: string | null;
  readonly eventType: string;
  readonly payload: Record<string, unknown> | null;
  readonly seqId: string;
  readonly createdAt: Date;
}

function withoutMorningBriefPart(
  payload: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!payload || !("userMessage" in payload)) {
    return payload;
  }
  const userMessage = payload.userMessage as {
    readonly version: number;
    readonly parts: readonly Record<string, unknown>[];
  };
  return {
    ...payload,
    userMessage: {
      ...userMessage,
      parts: userMessage.parts.filter((part) => {
        return part.type !== "morning_brief";
      }),
    },
  };
}

async function expectPhaseBRejection(
  client: Client,
  migrationSql: string,
  expectedMessage: string,
): Promise<void> {
  await assert.rejects(client.query(migrationSql), (error: unknown) => {
    return error instanceof Error && error.message.includes(expectedMessage);
  });
}

async function seedHistoricalShapes(client: Client): Promise<void> {
  await client.query(`
    INSERT INTO "org_members_metadata" ("org_id", "user_id")
    VALUES ('org_morning_brief_phase_b', 'user_morning_brief_phase_b');

    INSERT INTO "morning_brief_schedules" (
      "org_id", "user_id", "next_run_at"
    ) VALUES (
      'org_morning_brief_phase_b',
      'user_morning_brief_phase_b',
      NULL
    );

    INSERT INTO "agent_sessions" ("id", "user_id", "org_id")
    VALUES (
      '${fixtureUuid(800)}',
      'user_morning_brief_phase_b',
      'org_morning_brief_phase_b'
    );
  `);

  await client.query(`
    ALTER TABLE "morning_brief_deliveries"
      DISABLE TRIGGER "reject_legacy_morning_brief_delivery_1029";
    ALTER TABLE "chat_morning_brief_context"
      DISABLE TRIGGER "reject_legacy_morning_brief_context_1029";
    ALTER TABLE "email_outbox"
      DISABLE TRIGGER "reject_legacy_morning_brief_email_1029";
  `);

  try {
    for (const shape of historicalShapes) {
      const threadId = fixtureUuid(100 + shape.index);
      const sourceId = fixtureUuid(200 + shape.index);
      const replacementId = fixtureUuid(300 + shape.index);
      const assistantId = fixtureUuid(400 + shape.index);
      const terminalId = fixtureUuid(500 + shape.index);
      const deliveryId = fixtureUuid(600 + shape.index);
      const runId = fixtureUuid(700 + shape.index);
      const userMessage = {
        version: 1,
        parts: [
          ...shape.parts,
          { type: "morning_brief", briefDate: shape.briefDate },
        ],
      };

      await client.query(
        `
          INSERT INTO "chat_threads" (
            "id", "user_id", "title", "last_chat_event_seq_id"
          ) VALUES ($1, 'user_morning_brief_phase_b', $2, 4)
        `,
        [threadId, shape.title],
      );
      await client.query(
        `
          INSERT INTO "morning_brief_deliveries" (
            "id", "org_id", "user_id", "brief_date", "status", "run_id"
          ) VALUES (
            $1,
            'org_morning_brief_phase_b',
            'user_morning_brief_phase_b',
            $2,
            $3,
            NULL
          )
        `,
        [deliveryId, shape.briefDate, shape.deliveryStatus],
      );
      await client.query(
        `
          INSERT INTO "chat_morning_brief_context" (
            "id", "chat_thread_id", "delivery_id", "timezone", "triggered_at"
          ) VALUES ($1, $2, $3, 'Asia/Shanghai', '2026-08-24T07:00:00Z')
        `,
        [sourceId, threadId, deliveryId],
      );
      await client.query(
        `
          INSERT INTO "chat_events" (
            "id", "chat_thread_id", "run_id", "revokes_event_id",
            "event_type", "payload", "context_type", "context_id",
            "seq_id", "created_at"
          ) VALUES (
            $1, $2, NULL, NULL, 'input.prompt', $3::jsonb,
            'morning_brief', $1, 1, '2026-08-24T07:00:00Z'
          )
        `,
        [sourceId, threadId, JSON.stringify({ userMessage })],
      );

      if (!shape.runStatus) {
        continue;
      }

      const assistantContent = `Visible assistant result ${shape.index}`;
      const isCompleted = shape.runStatus === "completed";
      const assistantEventType = isCompleted
        ? "output.message"
        : "output.error";
      const terminalEventType = `run.${shape.runStatus}`;
      const assistantPayload = isCompleted
        ? { content: assistantContent }
        : { content: assistantContent, error: `terminal_${shape.runStatus}` };

      await client.query(
        `
          INSERT INTO "agent_runs" (
            "id", "user_id", "session_id", "status", "prompt", "result",
            "org_id", "created_at", "completed_at"
          ) VALUES (
            $1,
            'user_morning_brief_phase_b',
            '${fixtureUuid(800)}',
            $2,
            $3,
            $4::jsonb,
            'org_morning_brief_phase_b',
            '2026-08-24T07:00:01Z',
            '2026-08-24T07:00:04Z'
          )
        `,
        [
          runId,
          shape.runStatus,
          `Historical Morning Brief prompt ${shape.index}`,
          JSON.stringify({
            type: "result",
            text: `Durable Run result ${shape.index}`,
          }),
        ],
      );
      await client.query(
        `
          INSERT INTO "chat_events" (
            "id", "chat_thread_id", "run_id", "revokes_event_id",
            "event_type", "payload", "context_type", "context_id",
            "seq_id", "created_at"
          ) VALUES
            (
              $1, $2, $3, $4, 'input.prompt', $5::jsonb,
              'morning_brief', $4, 2, '2026-08-24T07:00:01Z'
            ),
            (
              $6, $2, $3, NULL, $7, $8::jsonb,
              NULL, NULL, 3, '2026-08-24T07:00:02Z'
            ),
            (
              $9, $2, $3, NULL, $10, $8::jsonb,
              NULL, NULL, 4, '2026-08-24T07:00:03Z'
            )
        `,
        [
          replacementId,
          threadId,
          runId,
          sourceId,
          JSON.stringify({ userMessage }),
          assistantId,
          assistantEventType,
          JSON.stringify(assistantPayload),
          terminalId,
          terminalEventType,
        ],
      );
      await client.query(
        `
          INSERT INTO "agent_run_callbacks" (
            "id", "run_id", "internal_kind", "payload", "status",
            "attempts", "delivered_at"
          ) VALUES (
            $1,
            $2,
            'morning-brief:email',
            jsonb_build_object(
              'data',
              jsonb_build_object('deliveryId', $3::text)
            ),
            'delivered',
            1,
            '2026-08-24T07:00:05Z'
          )
        `,
        [fixtureUuid(900 + shape.index), runId, deliveryId],
      );
      await client.query(
        `
          UPDATE "morning_brief_deliveries"
          SET "run_id" = $1
          WHERE "id" = $2
        `,
        [runId, deliveryId],
      );
    }

    await client.query(
      `
        INSERT INTO "email_outbox" (
          "id", "from_address", "to_addresses", "subject", "template", "status"
        ) VALUES
          (
            $1,
            'Morning Brief <brief@example.test>',
            '["user@example.test"]'::jsonb,
            'Delivered legacy Morning Brief',
            '{"template":"morning-brief","props":{}}'::jsonb,
            'sent'
          ),
          (
            $2,
            'Okou <notifications@example.test>',
            '["user@example.test"]'::jsonb,
            'Generic Official Workflow result',
            '{"template":"official-automation-result","props":{}}'::jsonb,
            'sent'
          );
      `,
      [fixtureUuid(1001), fixtureUuid(1002)],
    );
  } finally {
    await client.query(`
      ALTER TABLE "morning_brief_deliveries"
        ENABLE TRIGGER "reject_legacy_morning_brief_delivery_1029";
      ALTER TABLE "chat_morning_brief_context"
        ENABLE TRIGGER "reject_legacy_morning_brief_context_1029";
      ALTER TABLE "email_outbox"
        ENABLE TRIGGER "reject_legacy_morning_brief_email_1029";
    `);
  }
}

async function appendTerminalRejection(client: Client): Promise<void> {
  const shape = historicalShapes[4]!;
  const threadId = fixtureUuid(100 + shape.index);
  const sourceId = fixtureUuid(200 + shape.index);
  const replacementId = fixtureUuid(300 + shape.index);
  const assistantId = fixtureUuid(400 + shape.index);
  const userMessage = {
    version: 1,
    parts: [
      ...shape.parts,
      { type: "morning_brief", briefDate: shape.briefDate },
    ],
  };
  await client.query(
    `
      INSERT INTO "chat_events" (
        "id", "chat_thread_id", "run_id", "revokes_event_id", "event_type",
        "payload", "context_type", "context_id", "seq_id", "created_at"
      ) VALUES
        (
          $1, $2, NULL, $3, 'input.rejected', $4::jsonb,
          'morning_brief', $3, 2, '2026-08-24T07:00:01Z'
        ),
        (
          $5, $2, NULL, NULL, 'output.error', $6::jsonb,
          NULL, NULL, 3, '2026-08-24T07:00:02Z'
        );
    `,
    [
      replacementId,
      threadId,
      sourceId,
      JSON.stringify({
        userMessage,
        error: "legacy_morning_brief_cutover",
      }),
      assistantId,
      JSON.stringify({
        content:
          "This legacy Morning Brief was stopped during the Official Workflow cutover.",
        error: "legacy_morning_brief_cutover",
      }),
    ],
  );
}

async function loadHistoricalEvents(
  client: Client,
): Promise<readonly HistoricalEventSnapshot[]> {
  const result = await client.query<HistoricalEventSnapshot>(
    `
    SELECT
      "id",
      "chat_thread_id" AS "chatThreadId",
      "run_id" AS "runId",
      "revokes_event_id" AS "revokesEventId",
      "event_type" AS "eventType",
      "payload",
      "seq_id"::text AS "seqId",
      "created_at" AS "createdAt"
    FROM "chat_events"
    WHERE "chat_thread_id" = ANY($1::uuid[])
    ORDER BY "chat_thread_id", "seq_id"
  `,
    [
      historicalShapes.map((shape) => {
        return fixtureUuid(100 + shape.index);
      }),
    ],
  );
  return result.rows;
}

async function assertHistoricalReadability(
  client: Client,
  beforeEvents: readonly HistoricalEventSnapshot[],
): Promise<void> {
  const afterEvents = await loadHistoricalEvents(client);
  assert.equal(afterEvents.length, beforeEvents.length);
  for (let index = 0; index < beforeEvents.length; index++) {
    const before = beforeEvents[index]!;
    const after = afterEvents[index]!;
    assert.deepEqual(
      {
        ...after,
        payload: undefined,
      },
      {
        ...before,
        payload: undefined,
      },
    );
    assert.deepEqual(after.payload, withoutMorningBriefPart(before.payload));
    const userMessage = after.payload?.userMessage;
    if (userMessage) {
      userMessageDocumentSchema.parse(userMessage);
    }
  }

  const contexts = await client.query<{
    contextType: string | null;
    contextId: string | null;
  }>(
    `
    SELECT
      "context_type" AS "contextType",
      "context_id" AS "contextId"
    FROM "chat_events"
    WHERE "id" = ANY($1::uuid[])
      OR "revokes_event_id" = ANY($1::uuid[])
    ORDER BY "id"
  `,
    [
      historicalShapes.map((shape) => {
        return fixtureUuid(200 + shape.index);
      }),
    ],
  );
  assert.ok(contexts.rows.length > 0);
  assert.ok(
    contexts.rows.every((row) => {
      return row.contextType === "web" && row.contextId === null;
    }),
  );

  const pending = await client.query<{ count: string }>(
    `
    SELECT count(*)::text AS "count"
    FROM "chat_events" AS "source"
    WHERE "source"."id" = ANY($1::uuid[])
      AND "source"."event_type" = 'input.prompt'
      AND "source"."run_id" IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM "chat_events" AS "revoker"
        WHERE "revoker"."revokes_event_id" = "source"."id"
      )
  `,
    [
      historicalShapes.map((shape) => {
        return fixtureUuid(200 + shape.index);
      }),
    ],
  );
  assert.equal(pending.rows[0]?.count, "0");

  const visible = await client.query<{
    title: string;
    userMessage: unknown;
    assistantContent: string;
    runResult: unknown;
  }>(
    `
    SELECT
      "thread"."title",
      "replacement"."payload" -> 'userMessage' AS "userMessage",
      "assistant"."payload" ->> 'content' AS "assistantContent",
      "run"."result" AS "runResult"
    FROM "chat_threads" AS "thread"
    INNER JOIN "chat_events" AS "source"
      ON "source"."id" = ANY($1::uuid[])
      AND "source"."chat_thread_id" = "thread"."id"
    INNER JOIN "chat_events" AS "replacement"
      ON "replacement"."revokes_event_id" = "source"."id"
    INNER JOIN "chat_events" AS "assistant"
      ON "assistant"."chat_thread_id" = "thread"."id"
      AND "assistant"."event_type" IN ('output.message', 'output.error')
    LEFT JOIN "agent_runs" AS "run"
      ON "run"."id" = "replacement"."run_id"
    ORDER BY "thread"."id"
  `,
    [
      historicalShapes.map((shape) => {
        return fixtureUuid(200 + shape.index);
      }),
    ],
  );
  assert.equal(visible.rows.length, historicalShapes.length);
  for (const [index, row] of visible.rows.entries()) {
    const shape = historicalShapes[index]!;
    assert.equal(row.title, shape.title);
    userMessageDocumentSchema.parse(row.userMessage);
    assert.ok(row.assistantContent.length > 0);
    if (shape.runStatus) {
      assert.deepEqual(row.runResult, {
        type: "result",
        text: `Durable Run result ${shape.index}`,
      });
    } else {
      assert.equal(row.runResult, null);
    }
  }
}

async function assertPhysicalRemoval(client: Client): Promise<void> {
  const objects = await client.query<{
    contexts: string | null;
    deliveries: string | null;
    schedules: string | null;
  }>(`
    SELECT
      to_regclass('public.chat_morning_brief_context')::text AS "contexts",
      to_regclass('public.morning_brief_deliveries')::text AS "deliveries",
      to_regclass('public.morning_brief_schedules')::text AS "schedules"
  `);
  assert.deepEqual(objects.rows[0], {
    contexts: null,
    deliveries: null,
    schedules: null,
  });

  const column = await client.query<{ count: string }>(`
    SELECT count(*)::text AS "count"
    FROM "information_schema"."columns"
    WHERE "table_schema" = 'public'
      AND "table_name" = 'org_members_metadata'
      AND "column_name" = 'morning_brief_enabled'
  `);
  assert.equal(column.rows[0]?.count, "0");

  const compatibilityObjects = await client.query<{ count: string }>(`
    SELECT count(*)::text AS "count"
    FROM (
      SELECT "tgname" AS "name"
      FROM "pg_trigger"
      WHERE "tgname" LIKE '%morning_brief%_1029'
      UNION ALL
      SELECT "proname" AS "name"
      FROM "pg_proc"
      WHERE "proname" LIKE '%morning_brief%_1029'
      UNION ALL
      SELECT "relname" AS "name"
      FROM "pg_class"
      WHERE "relname" IN (
        'idx_morning_brief_deliveries_org_user_date',
        'idx_morning_brief_deliveries_run',
        'idx_morning_brief_schedules_next_run'
      )
    ) AS "legacy"
  `);
  assert.equal(compatibilityObjects.rows[0]?.count, "0");

  const contextConstraint = await client.query<{ definition: string }>(`
    SELECT pg_get_constraintdef("oid") AS "definition"
    FROM "pg_constraint"
    WHERE "conrelid" = 'public.chat_events'::regclass
      AND "conname" = 'chat_events_context_type_check'
  `);
  assert.equal(contextConstraint.rows.length, 1);
  assert.doesNotMatch(contextConstraint.rows[0]!.definition, /morning_brief/u);

  const terminalBookkeeping = await client.query<{
    callbackCount: string;
    normalizedCallbackCount: string;
    genericOutboxCount: string;
    legacyOutboxCount: string;
  }>(
    `
    SELECT
      (
        SELECT count(*)::text
        FROM "agent_run_callbacks"
        WHERE "internal_kind" = 'morning-brief:email'
      ) AS "callbackCount",
      (
        SELECT count(*)::text
        FROM "agent_run_callbacks"
        WHERE "id" = ANY($1::uuid[])
          AND "internal_kind" IS NULL
          AND "payload" IS NULL
          AND "status" = 'delivered'
          AND "run_id" IS NOT NULL
      ) AS "normalizedCallbackCount",
      (
        SELECT count(*)::text
        FROM "email_outbox"
        WHERE "template" ->> 'template' = 'official-automation-result'
      ) AS "genericOutboxCount",
      (
        SELECT count(*)::text
        FROM "email_outbox"
        WHERE "template" ->> 'template' = 'morning-brief'
      ) AS "legacyOutboxCount"
  `,
    [
      historicalShapes.slice(0, 4).map((shape) => {
        return fixtureUuid(900 + shape.index);
      }),
    ],
  );
  assert.deepEqual(terminalBookkeeping.rows[0], {
    callbackCount: "0",
    normalizedCallbackCount: "4",
    genericOutboxCount: "1",
    legacyOutboxCount: "0",
  });

  await assert.rejects(
    client.query(`
      UPDATE "chat_events"
      SET "created_at" = "created_at"
      WHERE "id" = '${fixtureUuid(201)}'
    `),
    /chat_events is append-only; UPDATE is not allowed/u,
  );
}

export async function validateMorningBriefPhaseBCleanup(): Promise<void> {
  console.log("=== Validate Morning Brief phase-B cleanup ===\n");

  const baseUrl = process.env.DATABASE_URL;
  assert.ok(baseUrl, "DATABASE_URL is required");
  const admin = new Client({
    connectionString: databaseUrl(baseUrl, "postgres"),
  });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${testDatabase}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${testDatabase}"`);

  const client = new Client({
    connectionString: databaseUrl(baseUrl, testDatabase),
  });
  await client.connect();
  try {
    await applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      previousMigration,
    );
    await seedHistoricalShapes(client);
    const migrationSql = await fs.readFile(
      path.join(migrationsDirectory, `${MORNING_BRIEF_PHASE_B_MIGRATION}.sql`),
      "utf8",
    );

    await client.query(`
      ALTER TABLE "org_members_metadata"
        DISABLE TRIGGER "force_legacy_morning_brief_disabled_1029";
      UPDATE "org_members_metadata"
      SET "morning_brief_enabled" = true
      WHERE "org_id" = 'org_morning_brief_phase_b';
      ALTER TABLE "org_members_metadata"
        ENABLE TRIGGER "force_legacy_morning_brief_disabled_1029";
    `);
    await expectPhaseBRejection(
      client,
      migrationSql,
      "Morning Brief preferences were not terminalized",
    );
    await client.query(`
      UPDATE "org_members_metadata"
      SET "morning_brief_enabled" = false
      WHERE "org_id" = 'org_morning_brief_phase_b'
    `);

    await client.query(`
      ALTER TABLE "morning_brief_schedules"
        DISABLE TRIGGER "pause_legacy_morning_brief_schedule_1029";
      UPDATE "morning_brief_schedules"
      SET "next_run_at" = '2026-08-31T00:00:00Z'
      WHERE "org_id" = 'org_morning_brief_phase_b';
      ALTER TABLE "morning_brief_schedules"
        ENABLE TRIGGER "pause_legacy_morning_brief_schedule_1029";
    `);
    await expectPhaseBRejection(
      client,
      migrationSql,
      "Morning Brief schedules are still due",
    );
    await client.query(`
      UPDATE "morning_brief_schedules"
      SET "next_run_at" = NULL
      WHERE "org_id" = 'org_morning_brief_phase_b'
    `);

    await client.query(`
      ALTER TABLE "morning_brief_deliveries"
        DISABLE TRIGGER "reject_legacy_morning_brief_delivery_1029";
      UPDATE "morning_brief_deliveries"
      SET "status" = 'running'
      WHERE "id" = '${fixtureUuid(601)}';
      ALTER TABLE "morning_brief_deliveries"
        ENABLE TRIGGER "reject_legacy_morning_brief_delivery_1029";
    `);
    await expectPhaseBRejection(
      client,
      migrationSql,
      "Morning Brief deliveries are not terminal",
    );
    await client.query(`
      UPDATE "morning_brief_deliveries"
      SET "status" = 'emailed'
      WHERE "id" = '${fixtureUuid(601)}'
    `);

    await client.query(`
      UPDATE "agent_run_callbacks"
      SET "status" = 'pending'
      WHERE "id" = '${fixtureUuid(901)}'
    `);
    await expectPhaseBRejection(
      client,
      migrationSql,
      "Morning Brief callbacks are not terminal",
    );
    await client.query(`
      UPDATE "agent_run_callbacks"
      SET "status" = 'delivered'
      WHERE "id" = '${fixtureUuid(901)}'
    `);

    await client.query(`
      UPDATE "email_outbox"
      SET "status" = 'pending'
      WHERE "id" = '${fixtureUuid(1002)}'
    `);
    await expectPhaseBRejection(
      client,
      migrationSql,
      "Email outbox contains unsent work",
    );
    await client.query(`
      UPDATE "email_outbox"
      SET "status" = 'sent'
      WHERE "id" = '${fixtureUuid(1002)}'
    `);

    await expectPhaseBRejection(
      client,
      migrationSql,
      "Morning Brief context does not have one terminal replacement",
    );
    await appendTerminalRejection(client);

    const beforeEvents = await loadHistoricalEvents(client);
    const beforeRunResults = await client.query(
      `
      SELECT "id", "status", "prompt", "result"
      FROM "agent_runs"
      WHERE "id" = ANY($1::uuid[])
      ORDER BY "id"
    `,
      [
        historicalShapes.flatMap((shape) => {
          return shape.runStatus ? [fixtureUuid(700 + shape.index)] : [];
        }),
      ],
    );

    await applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      MORNING_BRIEF_PHASE_B_MIGRATION,
    );

    await assertHistoricalReadability(client, beforeEvents);
    const afterRunResults = await client.query(
      `
      SELECT "id", "status", "prompt", "result"
      FROM "agent_runs"
      WHERE "id" = ANY($1::uuid[])
      ORDER BY "id"
    `,
      [
        historicalShapes.flatMap((shape) => {
          return shape.runStatus ? [fixtureUuid(700 + shape.index)] : [];
        }),
      ],
    );
    assert.deepEqual(afterRunResults.rows, beforeRunResults.rows);
    await assertPhysicalRemoval(client);

    console.log("   ✅ enabled preferences and due schedules fail closed");
    console.log("   ✅ active delivery, callback, and email work fail closed");
    console.log("   ✅ five historical Chat shapes retain visible documents");
    console.log(
      "   ✅ Run links, assistant output, and Run results are unchanged",
    );
    console.log("   ✅ migrated prompts cannot re-enter queue admission");
    console.log(
      "   ✅ legacy physical identities and dispatch rows are absent\n",
    );
  } finally {
    await client.end();
    await admin.query(`DROP DATABASE IF EXISTS "${testDatabase}" WITH (FORCE)`);
    await admin.end();
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  validateMorningBriefPhaseBCleanup().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
