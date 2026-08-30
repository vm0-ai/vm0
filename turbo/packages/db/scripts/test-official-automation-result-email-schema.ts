import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

import { applyMigrationsFromDirectoryUpToTag } from "./migration-consistency-helpers";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsDirectory = path.join(scriptDirectory, "../src/migrations");
const previousMigration = "1015_canonical_built_in_provider_schema";
const resultEmailMigration = "1016_short_korvac";
const upgradeDatabase = "migration_official_automation_result_email";

const officialBindingConstraint = "workflow_automations_official_binding_check";

function databaseErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function databaseErrorConstraint(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("constraint" in error)) {
    return undefined;
  }
  return typeof error.constraint === "string" ? error.constraint : undefined;
}

export async function validateOfficialAutomationResultEmailMigration(): Promise<void> {
  console.log("=== Validate Official Automation result-email migration ===\n");
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL is required");
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  const upgradeUrl = new URL(databaseUrl);
  upgradeUrl.pathname = `/${upgradeDatabase}`;

  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(
    `DROP DATABASE IF EXISTS "${upgradeDatabase}" WITH (FORCE)`,
  );
  await admin.query(`CREATE DATABASE "${upgradeDatabase}"`);

  const client = new Client({ connectionString: upgradeUrl.toString() });
  await client.connect();
  try {
    await applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      previousMigration,
    );
    const fixture = {
      agentId: "00000000-0000-4000-8000-000000101401",
      workflowId: "00000000-0000-4000-8000-000000101402",
      ordinaryAutomationId: "00000000-0000-4000-8000-000000101403",
      orgId: "official-result-migration-org",
      userId: "official-result-migration-user",
      definitionName: "official-result-migration",
    } as const;
    await client.query(
      `
        INSERT INTO "agents" ("id", "org_id", "owner", "name")
        VALUES ($1, $2, $3, $4)
      `,
      [fixture.agentId, fixture.orgId, fixture.userId, fixture.definitionName],
    );
    await client.query(
      `
        INSERT INTO "zero_workflows" (
          "id", "org_id", "name", "created_by", "owner_user_id",
          "agent_id", "updated_by", "official_definition_name",
          "official_installation_state"
        ) VALUES ($1, $2, $3, $4, $4, $5, $4, $3, 'installed')
      `,
      [
        fixture.workflowId,
        fixture.orgId,
        fixture.definitionName,
        fixture.userId,
        fixture.agentId,
      ],
    );
    await client.query(
      `
        INSERT INTO "zero_workflow_automations" (
          "id", "org_id", "workflow_id", "owner_user_id",
          "kind", "schedule_type", "interval_seconds"
        ) VALUES ($1, $2, $3, $4, 'schedule', 'loop', 60)
      `,
      [
        fixture.ordinaryAutomationId,
        fixture.orgId,
        fixture.workflowId,
        fixture.userId,
      ],
    );

    await applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      resultEmailMigration,
    );
    const upgraded = await client.query<{
      id: string;
      resultEmailEnabled: boolean | null;
    }>(
      `
        SELECT
          "id",
          "official_result_email_enabled" AS "resultEmailEnabled"
        FROM "zero_workflow_automations"
        WHERE "id" = ANY($1::uuid[])
        ORDER BY "id"
      `,
      [[fixture.ordinaryAutomationId]],
    );
    assert.deepEqual(upgraded.rows, [
      {
        id: fixture.ordinaryAutomationId,
        resultEmailEnabled: null,
      },
    ]);

    await applyMigrationsFromDirectoryUpToTag(
      client,
      migrationsDirectory,
      resultEmailMigration,
    );
    assert.deepEqual(
      (
        await client.query<{
          resultEmailEnabled: boolean | null;
        }>(
          `
            SELECT "official_result_email_enabled" AS "resultEmailEnabled"
            FROM "zero_workflow_automations"
            WHERE "id" = $1
          `,
          [fixture.ordinaryAutomationId],
        )
      ).rows,
      [{ resultEmailEnabled: null }],
    );

    console.log("   ✅ ordinary Automations retain a null projection");
    console.log("   ✅ migration-runner replay is idempotent\n");
  } finally {
    await client.end();
    await admin.query(
      `DROP DATABASE IF EXISTS "${upgradeDatabase}" WITH (FORCE)`,
    );
    await admin.end();
  }
}

export async function validateOfficialAutomationResultEmailSchema(
  databaseUrl: string,
): Promise<void> {
  console.log("=== Validate Official Automation result-email schema ===\n");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query("BEGIN");

  try {
    const identity = randomUUID();
    const agentId = randomUUID();
    const workflowId = randomUUID();
    const officialAutomationId = randomUUID();
    const ordinaryAutomationId = randomUUID();
    const orgId = `official-result-org-${identity}`;
    const userId = `official-result-user-${identity}`;
    const definitionName = `official-result-${identity}`;

    await client.query(
      `
        INSERT INTO "agents" ("id", "org_id", "owner", "name")
        VALUES ($1, $2, $3, $4)
      `,
      [agentId, orgId, userId, definitionName],
    );
    await client.query(
      `
        INSERT INTO "workflows" (
          "id", "org_id", "name", "created_by", "owner_user_id",
          "agent_id", "updated_by", "official_definition_name",
          "official_installation_state"
        ) VALUES ($1, $2, $3, $4, $4, $5, $4, $3, 'installed')
      `,
      [workflowId, orgId, definitionName, userId, agentId],
    );
    await client.query(
      `
        INSERT INTO "workflow_automations" (
          "id", "org_id", "workflow_id", "owner_user_id",
          "kind", "schedule_type", "interval_seconds"
        ) VALUES
          ($1, $2, $3, $4, 'schedule', 'loop', 60),
          ($5, $2, $3, $4, 'schedule', 'loop', 120)
      `,
      [officialAutomationId, orgId, workflowId, userId, ordinaryAutomationId],
    );

    const ordinaryBefore = await client.query<{
      resultEmailEnabled: boolean | null;
    }>(
      `
        SELECT "official_result_email_enabled" AS "resultEmailEnabled"
        FROM "workflow_automations"
        WHERE "id" = $1
      `,
      [ordinaryAutomationId],
    );
    assert.deepEqual(ordinaryBefore.rows, [{ resultEmailEnabled: null }]);

    await client.query(
      `
        UPDATE "workflow_automations"
        SET
          "official_blueprint_key" = 'pulse',
          "official_applied_fingerprint" = $1,
          "official_reconciliation_status" = 'current',
          "official_parameter_bindings" = '[]'::jsonb,
          "official_intended_enabled" = true,
          "official_result_email_enabled" = false
        WHERE "id" = $2
      `,
      ["a".repeat(64), officialAutomationId],
    );
    const officialDisabled = await client.query<{
      resultEmailEnabled: boolean | null;
    }>(
      `
        SELECT "official_result_email_enabled" AS "resultEmailEnabled"
        FROM "workflow_automations"
        WHERE "id" = $1
      `,
      [officialAutomationId],
    );
    assert.deepEqual(officialDisabled.rows, [{ resultEmailEnabled: false }]);

    await client.query(
      `
        UPDATE "workflow_automations"
        SET "official_result_email_enabled" = true
        WHERE "id" = $1
      `,
      [officialAutomationId],
    );
    const officialEnabled = await client.query<{
      resultEmailEnabled: boolean | null;
    }>(
      `
        SELECT "official_result_email_enabled" AS "resultEmailEnabled"
        FROM "workflow_automations"
        WHERE "id" = $1
      `,
      [officialAutomationId],
    );
    assert.deepEqual(officialEnabled.rows, [{ resultEmailEnabled: true }]);

    await assert.rejects(
      client.query(
        `
          UPDATE "workflow_automations"
          SET "official_result_email_enabled" = true
          WHERE "id" = $1
        `,
        [ordinaryAutomationId],
      ),
      (error: unknown) => {
        return (
          databaseErrorCode(error) === "23514" &&
          databaseErrorConstraint(error) === officialBindingConstraint
        );
      },
    );

    console.log("   ✅ ordinary Automations retain a null projection");
    console.log("   ✅ Official Automations retain an explicit boolean\n");
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL is required");
  validateOfficialAutomationResultEmailMigration()
    .then(async () => {
      await validateOfficialAutomationResultEmailSchema(databaseUrl);
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
