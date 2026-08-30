import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

import { applyMigrationsFromDirectoryUpToTag } from "./migration-consistency-helpers";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.join(scriptDirectory, "../src/migrations");
const previousMigration = "1028_contract_chat_event_snapshot_v7";
export const MORNING_BRIEF_PHASE_A_MIGRATION =
  "1029_morning_brief_phase_a_cutover";
const testDatabase = "migration_morning_brief_phase_a_30264";

function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

async function expectCutoverRejection(
  client: Client,
  statement: string,
): Promise<void> {
  await assert.rejects(client.query(statement), (error: unknown) => {
    return (
      error instanceof Error &&
      "code" in error &&
      (error as Error & { readonly code: string }).code === "23514"
    );
  });
}

async function assertTerminalPreferences(client: Client): Promise<void> {
  const metadata = await client.query<{
    morningBriefEnabled: boolean;
    userId: string;
  }>(`
    SELECT
      "user_id" AS "userId",
      "morning_brief_enabled" AS "morningBriefEnabled"
    FROM "org_members_metadata"
    WHERE "org_id" = 'org_morning_brief_cutover'
    ORDER BY "user_id"
  `);
  assert.deepEqual(metadata.rows, [
    { morningBriefEnabled: false, userId: "user_enabled" },
    { morningBriefEnabled: false, userId: "user_stale_writer" },
  ]);

  const schedules = await client.query<{ nextRunAt: Date | null }>(`
    SELECT "next_run_at" AS "nextRunAt"
    FROM "morning_brief_schedules"
    WHERE "org_id" = 'org_morning_brief_cutover'
  `);
  assert.equal(schedules.rows.length, 1);
  assert.equal(schedules.rows[0]?.nextRunAt, null);
}

export async function validateMorningBriefPhaseACutover(): Promise<void> {
  console.log("=== Validate Morning Brief phase-A cutover ===\n");

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
    await client.query(`
      INSERT INTO "org_members_metadata" (
        "org_id", "user_id", "morning_brief_enabled"
      ) VALUES (
        'org_morning_brief_cutover', 'user_enabled', true
      );

      INSERT INTO "morning_brief_schedules" (
        "org_id", "user_id", "next_run_at"
      ) VALUES (
        'org_morning_brief_cutover',
        'user_enabled',
        '2026-08-31T00:00:00Z'
      );

      INSERT INTO "morning_brief_deliveries" (
        "id", "org_id", "user_id", "brief_date", "status"
      ) VALUES
        (
          '00000000-0000-4000-8000-000000003001',
          'org_morning_brief_cutover',
          'user_enabled',
          '2026-08-30',
          'collecting'
        ),
        (
          '00000000-0000-4000-8000-000000003002',
          'org_morning_brief_cutover',
          'user_enabled',
          '2026-08-29',
          'failed'
        );

      INSERT INTO "email_outbox" (
        "id", "from_address", "to_addresses", "subject", "template", "status"
      ) VALUES (
        '00000000-0000-4000-8000-000000003004',
        'Morning Brief <brief@example.test>',
        '["user@example.test"]'::jsonb,
        'Existing Morning Brief',
        '{"template":"morning-brief","props":{}}'::jsonb,
        'pending'
      );
    `);

    await applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      MORNING_BRIEF_PHASE_A_MIGRATION,
    );

    await client.query(`
      UPDATE "org_members_metadata"
      SET "morning_brief_enabled" = true
      WHERE "org_id" = 'org_morning_brief_cutover'
        AND "user_id" = 'user_enabled';

      INSERT INTO "org_members_metadata" (
        "org_id", "user_id", "morning_brief_enabled"
      ) VALUES (
        'org_morning_brief_cutover', 'user_stale_writer', true
      );

      UPDATE "morning_brief_schedules"
      SET "next_run_at" = '2026-09-01T00:00:00Z'
      WHERE "org_id" = 'org_morning_brief_cutover'
        AND "user_id" = 'user_enabled';
    `);
    await assertTerminalPreferences(client);

    await expectCutoverRejection(
      client,
      `
        INSERT INTO "morning_brief_deliveries" (
          "org_id", "user_id", "brief_date", "status"
        ) VALUES (
          'org_morning_brief_cutover',
          'user_enabled',
          '2026-08-31',
          'collecting'
        )
      `,
    );
    await expectCutoverRejection(
      client,
      `
        UPDATE "morning_brief_deliveries"
        SET "status" = 'collecting'
        WHERE "id" = '00000000-0000-4000-8000-000000003002'
      `,
    );
    await expectCutoverRejection(
      client,
      `
        INSERT INTO "chat_morning_brief_context" (
          "chat_thread_id", "delivery_id"
        ) VALUES (
          '00000000-0000-4000-8000-000000003003',
          '00000000-0000-4000-8000-000000003001'
        )
      `,
    );
    await expectCutoverRejection(
      client,
      `
        INSERT INTO "email_outbox" (
          "from_address", "to_addresses", "subject", "template"
        ) VALUES (
          'Morning Brief <brief@example.test>',
          '["user@example.test"]'::jsonb,
          'New Morning Brief',
          '{"template":"morning-brief","props":{}}'::jsonb
        )
      `,
    );

    await client.query(`
      UPDATE "morning_brief_deliveries"
      SET "status" = 'failed', "error" = 'phase A terminal handler'
      WHERE "id" = '00000000-0000-4000-8000-000000003001';

      UPDATE "email_outbox"
      SET "status" = 'sent'
      WHERE "id" = '00000000-0000-4000-8000-000000003004';

      INSERT INTO "email_outbox" (
        "from_address", "to_addresses", "subject", "template"
      ) VALUES (
        'Okou <notifications@example.test>',
        '["user@example.test"]'::jsonb,
        'Official Workflow result',
        '{"template":"official-automation-result","props":{}}'::jsonb
      );
    `);
    const terminal = await client.query<{ status: string }>(`
      SELECT "status"
      FROM "morning_brief_deliveries"
      WHERE "id" = '00000000-0000-4000-8000-000000003001'
    `);
    assert.equal(terminal.rows[0]?.status, "failed");
    const outbox = await client.query<{ status: string; template: string }>(`
      SELECT
        "status",
        "template" ->> 'template' AS "template"
      FROM "email_outbox"
      WHERE "subject" IN ('Existing Morning Brief', 'Official Workflow result')
      ORDER BY "subject"
    `);
    assert.deepEqual(outbox.rows, [
      { status: "sent", template: "morning-brief" },
      { status: "pending", template: "official-automation-result" },
    ]);

    const migrationSql = await fs.readFile(
      path.join(migrationsDirectory, `${MORNING_BRIEF_PHASE_A_MIGRATION}.sql`),
      "utf8",
    );
    assert.doesNotMatch(
      migrationSql,
      /official_workflow|workflow_automations/iu,
    );
    assert.equal(
      [...migrationSql.matchAll(/^UPDATE\s+"([^"]+)"/gimu)]
        .map((match) => {
          return match[1];
        })
        .join(","),
      "org_members_metadata,morning_brief_schedules",
    );

    await client.query(migrationSql);
    await assertTerminalPreferences(client);

    console.log("   ✅ existing preferences and schedules are terminal");
    console.log("   ✅ stale writers cannot reactivate or launch legacy work");
    console.log(
      "   ✅ legacy email admission is blocked without touching pending mail",
    );
    console.log("   ✅ in-flight legacy rows may still transition to terminal");
    console.log(
      "   ✅ replay is idempotent and Official tables are untouched\n",
    );
  } finally {
    await client.end();
    await admin.query(`DROP DATABASE IF EXISTS "${testDatabase}" WITH (FORCE)`);
    await admin.end();
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  validateMorningBriefPhaseACutover().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
