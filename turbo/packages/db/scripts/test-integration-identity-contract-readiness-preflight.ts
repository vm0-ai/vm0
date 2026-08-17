#!/usr/bin/env tsx
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import {
  CATALOG_DEPENDENCY_QUERY,
  INTEGRATION_IDENTITY_TABLES,
  type CatalogDependencyKind,
  type CatalogDependencySourceRow,
} from "./integration-identity-contract-readiness-preflight-manifest";
import {
  PREFLIGHT_OUTPUT_ALLOWLIST,
  SanitizedPreflightError,
  assertOutputAllowlist,
  classifyPreflightInventory,
  executeIntegrationIdentityContractReadinessPreflight,
  sanitizedFailureResult,
  withReadOnlySnapshot,
  type PreflightCapabilities,
  type PreflightInventory,
  type RowInventoryRow,
} from "./integration-identity-contract-readiness-preflight";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDirectory = path.resolve(dirname, "..");
const repositoryRoot = path.resolve(dirname, "../../../..");
const testDatabase = "integration_identity_contract_readiness_preflight_test";

const capabilities: PreflightCapabilities = {
  serverVersionClassification: "supported",
  transactionReadOnly: true,
  isolationLevel: "repeatable read",
  lockTimeoutMs: 1000,
  statementTimeoutMs: 30_000,
};

const emptyCatalog: Record<CatalogDependencyKind, readonly string[]> = {
  columns: [],
  primaryKeys: [],
  constraints: [],
  defaultsAndGenerated: [],
  indexes: [],
  triggers: [],
  functions: [],
  rewriteDependents: [],
  otherDependents: [],
};

function rowInventory(invalidTable?: string): readonly RowInventoryRow[] {
  return INTEGRATION_IDENTITY_TABLES.map(({ tableName }) => {
    return {
      tableName,
      totalCount: "1",
      invalidCount: tableName === invalidTable ? "1" : "0",
    };
  });
}

function inventory(
  rows: readonly RowInventoryRow[],
  catalogDependencies: readonly CatalogDependencySourceRow[] = [],
): PreflightInventory {
  return { rows, catalogDependencies };
}

function gatePresent(
  result: { readonly failureGates: readonly string[] },
  gate: string,
): void {
  assert.ok(result.failureGates.includes(gate), `missing gate ${gate}`);
}

function testStaticClassification(): void {
  const valid = classifyPreflightInventory(
    capabilities,
    inventory(rowInventory()),
    emptyCatalog,
  );
  assert.equal(valid.status, "passed");
  assert.equal(valid.rows.total_count, 12);
  assert.equal(valid.rows.invalid_count, 0);
  assertOutputAllowlist(valid);
  assert.deepEqual(
    PREFLIGHT_OUTPUT_ALLOWLIST,
    [...new Set(PREFLIGHT_OUTPUT_ALLOWLIST)].sort(),
  );

  const nullPair = classifyPreflightInventory(
    capabilities,
    inventory(rowInventory("agentphone_user_links")),
    emptyCatalog,
  );
  assert.equal(nullPair.rows.invalid_count, 1);
  gatePresent(nullPair, "rows.agentphone_user_links.invalid");

  const mismatchedPair = classifyPreflightInventory(
    capabilities,
    inventory(rowInventory("telegram_user_links")),
    emptyCatalog,
  );
  assert.equal(mismatchedPair.rows.invalid_count, 1);
  gatePresent(mismatchedPair, "rows.telegram_user_links.invalid");

  const rawIdentity = "never-emit-provider-row-or-org-identifier";
  const rawDefinition = "never-emit-raw-catalog-definition";
  const driftRows: CatalogDependencySourceRow[] = [
    {
      kind: "constraints",
      identity: rawIdentity,
      definition: rawDefinition,
    },
    {
      kind: "constraints",
      identity: "never-emit-second-catalog-identity",
      definition: "never-emit-second-catalog-definition",
    },
  ];
  const forward = classifyPreflightInventory(
    capabilities,
    inventory(rowInventory(), driftRows),
    emptyCatalog,
  );
  const reverse = classifyPreflightInventory(
    capabilities,
    inventory([...rowInventory()].reverse(), [...driftRows].reverse()),
    emptyCatalog,
  );
  assert.deepEqual(reverse, forward);
  gatePresent(forward, "dependencies.constraints");
  const serialized = JSON.stringify(forward);
  assert.equal(serialized.includes(rawIdentity), false);
  assert.equal(serialized.includes(rawDefinition), false);

  const failure = sanitizedFailureResult(
    new Error("never-emit-unhandled-error-detail"),
  );
  const failureJson = JSON.stringify(failure);
  assert.equal(
    failureJson.includes("never-emit-unhandled-error-detail"),
    false,
  );
  assert.deepEqual(failure.failureGates, ["probe.unexpected"]);
  assert.deepEqual(
    sanitizedFailureResult(
      new SanitizedPreflightError("probe.database_resolution"),
    ).failureGates,
    ["probe.database_resolution"],
  );
  assert.throws(
    () => {
      assertOutputAllowlist({
        ...valid,
        failureGates: ["never-emit-raw-failure-gate"],
      });
    },
    (error: unknown) => {
      return (
        error instanceof SanitizedPreflightError &&
        error.gate === "probe.output_contract"
      );
    },
  );
}

async function testRepositoryContracts(): Promise<void> {
  const workflow = await fs.readFile(
    path.join(
      repositoryRoot,
      ".github/workflows/integration-identity-contract-readiness-preflight.yml",
    ),
    "utf8",
  );
  assert.match(workflow, /^on:\n {2}workflow_dispatch:\s*$/mu);
  assert.match(workflow, /^ {4}environment: production$/mu);
  assert.match(workflow, /^ {4}if: github\.ref == 'refs\/heads\/main'$/mu);
  assert.match(workflow, /^ {10}ref: main$/mu);
  assert.match(
    workflow,
    /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/u,
  );
  assert.match(workflow, /#27665; removal-owner: #27602/u);
  assert.match(
    workflow,
    /scripts\/integration-identity-contract-readiness-preflight\.ts/u,
  );
  assert.match(workflow, /--ssl verify-full \\/u);
  assert.equal(
    /pull_request:|schedule:|actions\/upload-artifact/iu.test(workflow),
    false,
  );

  const migrationGuide = await fs.readFile(
    path.join(repositoryRoot, "turbo/packages/db/MIGRATIONS.md"),
    "utf8",
  );
  assert.match(
    migrationGuide,
    /vm0-transition-validator:#27665\|integration-identity-contract-readiness-preflight\|removal-owner:#27602/u,
  );

  const probe = await fs.readFile(
    path.join(
      repositoryRoot,
      "turbo/packages/db/scripts/integration-identity-contract-readiness-preflight.ts",
    ),
    "utf8",
  );
  assert.match(
    probe,
    /BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY/u,
  );
  assert.match(probe, /current_setting\('transaction_read_only'\)/u);
  assert.match(probe, /set_config\('lock_timeout'/u);
  assert.match(probe, /set_config\('statement_timeout'/u);
  assert.equal(
    /FOR UPDATE|FOR SHARE|LOCK TABLE|pg_advisory/iu.test(probe),
    false,
  );
}

function databaseUrlFor(baseUrl: URL, database: string): string {
  const result = new URL(baseUrl);
  result.pathname = `/${database}`;
  return result.toString();
}

async function insertValidRows(client: Client): Promise<void> {
  await client.query(`
    SET session_replication_role = replica;
    INSERT INTO "agentphone_user_agent_preferences"
      ("user_id", "vm0_user_id", "org_id")
      VALUES ('never-emit-user-01', 'never-emit-user-01', 'never-emit-org-01');
    INSERT INTO "agentphone_user_links"
      ("phone_handle", "user_id", "vm0_user_id", "org_id")
      VALUES ('never-emit-phone-02', 'never-emit-user-02', 'never-emit-user-02', 'never-emit-org-02');
    INSERT INTO "feishu_org_connections"
      ("installation_id", "feishu_open_id", "user_id", "vm0_user_id")
      VALUES ('10000000-0000-4000-8000-000000000003', 'never-emit-feishu-03', 'never-emit-user-03', 'never-emit-user-03');
    INSERT INTO "feishu_user_agent_preferences"
      ("user_id", "vm0_user_id", "org_id")
      VALUES ('never-emit-user-04', 'never-emit-user-04', 'never-emit-org-04');
    INSERT INTO "github_user_links"
      ("github_user_id", "installation_id", "user_id", "vm0_user_id")
      VALUES ('never-emit-github-05', '10000000-0000-4000-8000-000000000005', 'never-emit-user-05', 'never-emit-user-05');
    INSERT INTO "slack_org_connections"
      ("slack_user_id", "slack_workspace_id", "user_id", "vm0_user_id")
      VALUES ('never-emit-slack-06', 'never-emit-workspace-06', 'never-emit-user-06', 'never-emit-user-06');
    INSERT INTO "slack_user_agent_preferences"
      ("user_id", "vm0_user_id", "org_id")
      VALUES ('never-emit-user-07', 'never-emit-user-07', 'never-emit-org-07');
    INSERT INTO "teams_org_connections"
      ("teams_tenant_id", "user_id", "vm0_user_id")
      VALUES ('never-emit-tenant-08', 'never-emit-user-08', 'never-emit-user-08');
    INSERT INTO "teams_user_agent_preferences"
      ("user_id", "vm0_user_id", "org_id")
      VALUES ('never-emit-user-09', 'never-emit-user-09', 'never-emit-org-09');
    INSERT INTO "telegram_official_user_links"
      ("telegram_user_id", "user_id", "vm0_user_id", "org_id")
      VALUES ('never-emit-telegram-10', 'never-emit-user-10', 'never-emit-user-10', 'never-emit-org-10');
    INSERT INTO "telegram_user_agent_preferences"
      ("user_id", "vm0_user_id", "org_id")
      VALUES ('never-emit-user-11', 'never-emit-user-11', 'never-emit-org-11');
    INSERT INTO "telegram_user_links"
      ("telegram_user_id", "installation_id", "user_id", "vm0_user_id")
      VALUES ('never-emit-telegram-12', 'never-emit-installation-12', 'never-emit-user-12', 'never-emit-user-12');
    SET session_replication_role = origin;
  `);
}

async function executeAndExpectDependencyDrift(
  connectionString: string,
  kind: CatalogDependencyKind,
): Promise<string> {
  const result = await executeIntegrationIdentityContractReadinessPreflight({
    connectionString,
  });
  assert.equal(result.status, "failed");
  gatePresent(result, `dependencies.${kind}`);
  return JSON.stringify(result);
}

async function restoreSyncTrigger(
  client: Client,
  tableName: string,
  triggerName: string,
): Promise<void> {
  await client.query(`
    CREATE TRIGGER "${triggerName}"
    BEFORE INSERT OR UPDATE OF "vm0_user_id", "user_id"
    ON "${tableName}"
    FOR EACH ROW EXECUTE FUNCTION "sync_integration_user_identity_0930"()
  `);
}

async function testDatabaseBoundaries(databaseUrl: string): Promise<void> {
  const sourceUrl = new URL(databaseUrl);
  const admin = new Client({
    connectionString: databaseUrlFor(sourceUrl, "postgres"),
  });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${testDatabase}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${testDatabase}"`);
  const testUrl = databaseUrlFor(sourceUrl, testDatabase);

  try {
    execFileSync("tsx", [path.join(dirname, "migrate.ts")], {
      cwd: packageDirectory,
      env: { ...process.env, DATABASE_URL: testUrl },
      stdio: "pipe",
    });
    const client = new Client({ connectionString: testUrl });
    const writer = new Client({ connectionString: testUrl });
    await client.connect();
    await writer.connect();
    try {
      await insertValidRows(client);
      const allValid =
        await executeIntegrationIdentityContractReadinessPreflight({
          connectionString: testUrl,
        });
      assert.equal(allValid.status, "passed");
      assert.equal(allValid.rows.total_count, 12);
      assert.equal(allValid.rows.invalid_count, 0);
      assert.equal(JSON.stringify(allValid).includes("never-emit"), false);

      await withReadOnlySnapshot(client, {}, async () => {
        await assert.rejects(
          client.query(`INSERT INTO "agentphone_user_links"
            ("phone_handle", "user_id", "vm0_user_id", "org_id")
            VALUES ('readonly-phone', 'readonly-user', 'readonly-user', 'readonly-org')`),
          (error: unknown) => {
            return (error as { readonly code?: unknown }).code === "25006";
          },
        );
      });

      await assert.rejects(
        withReadOnlySnapshot(client, { statementTimeoutMs: 25 }, async () => {
          await client.query("SELECT pg_sleep(0.2)");
        }),
        (error: unknown) => {
          return (
            error instanceof SanitizedPreflightError &&
            error.gate === "probe.statement_timeout"
          );
        },
      );

      await writer.query("BEGIN");
      try {
        await writer.query(
          `LOCK TABLE "agentphone_user_links" IN ACCESS EXCLUSIVE MODE`,
        );
        await assert.rejects(
          withReadOnlySnapshot(client, { lockTimeoutMs: 25 }, async () => {
            await client.query(`SELECT count(*) FROM "agentphone_user_links"`);
          }),
          (error: unknown) => {
            return (
              error instanceof SanitizedPreflightError &&
              error.gate === "probe.lock_timeout"
            );
          },
        );
      } finally {
        await writer.query("ROLLBACK");
      }

      const cancelled = new AbortController();
      cancelled.abort();
      await assert.rejects(
        withReadOnlySnapshot(client, { signal: cancelled.signal }, async () => {
          return undefined;
        }),
        (error: unknown) => {
          return (
            error instanceof SanitizedPreflightError &&
            error.gate === "probe.cancelled"
          );
        },
      );

      await writer.query("BEGIN");
      await writer.query(
        `LOCK TABLE "agentphone_user_links" IN ACCESS EXCLUSIVE MODE`,
      );
      const activeCancellation = new AbortController();
      const abortTimer = setTimeout(() => {
        activeCancellation.abort();
      }, 25);
      const releaseWriter = new Promise<void>((resolve, reject) => {
        setTimeout(() => {
          writer.query("ROLLBACK").then(() => {
            resolve();
          }, reject);
        }, 125);
      });
      try {
        await assert.rejects(
          executeIntegrationIdentityContractReadinessPreflight({
            connectionString: testUrl,
            signal: activeCancellation.signal,
            lockTimeoutMs: 1000,
            statementTimeoutMs: 2000,
          }),
          (error: unknown) => {
            return (
              error instanceof SanitizedPreflightError &&
              error.gate === "probe.cancelled"
            );
          },
        );
      } finally {
        clearTimeout(abortTimer);
        await releaseWriter;
      }

      await withReadOnlySnapshot(client, {}, async () => {
        const before = await client.query<{ count: string }>(
          `SELECT count(*)::text AS "count" FROM "agentphone_user_links"`,
        );
        await writer.query(`INSERT INTO "agentphone_user_links"
          ("phone_handle", "user_id", "vm0_user_id", "org_id")
          VALUES ('never-emit-phone-snapshot', 'never-emit-user-snapshot', 'never-emit-user-snapshot', 'never-emit-org-snapshot')`);
        const after = await client.query<{ count: string }>(
          `SELECT count(*)::text AS "count" FROM "agentphone_user_links"`,
        );
        assert.equal(before.rows[0]?.count, "1");
        assert.equal(after.rows[0]?.count, "1");
      });

      const firstRerun =
        await executeIntegrationIdentityContractReadinessPreflight({
          connectionString: testUrl,
        });
      const secondRerun =
        await executeIntegrationIdentityContractReadinessPreflight({
          connectionString: testUrl,
        });
      assert.deepEqual(secondRerun, firstRerun);
      assert.equal(firstRerun.rows.total_count, 13);

      const triggerTable = "agentphone_user_links";
      const triggerName = "sync_agentphone_user_links_identity_0930";
      await client.query(
        `ALTER TABLE "${triggerTable}" DISABLE TRIGGER "${triggerName}"`,
      );
      await client.query(
        `ALTER TABLE "${triggerTable}" ALTER COLUMN "vm0_user_id" DROP NOT NULL`,
      );
      await client.query(`UPDATE "${triggerTable}"
        SET "vm0_user_id" = NULL
        WHERE "phone_handle" = 'never-emit-phone-02'`);
      const nullPair =
        await executeIntegrationIdentityContractReadinessPreflight({
          connectionString: testUrl,
        });
      assert.equal(nullPair.rows.tables.agentphone_user_links.invalid_count, 1);
      gatePresent(nullPair, "rows.agentphone_user_links.invalid");
      gatePresent(nullPair, "dependencies.columns");
      await client.query(`UPDATE "${triggerTable}"
        SET "vm0_user_id" = "user_id"
        WHERE "phone_handle" = 'never-emit-phone-02'`);
      await client.query(
        `ALTER TABLE "${triggerTable}" ALTER COLUMN "vm0_user_id" SET NOT NULL`,
      );

      await client.query(`UPDATE "${triggerTable}"
        SET "vm0_user_id" = 'never-emit-mismatched-identity'
        WHERE "phone_handle" = 'never-emit-phone-02'`);
      const mismatchedPair =
        await executeIntegrationIdentityContractReadinessPreflight({
          connectionString: testUrl,
        });
      assert.equal(
        mismatchedPair.rows.tables.agentphone_user_links.invalid_count,
        1,
      );
      gatePresent(mismatchedPair, "rows.agentphone_user_links.invalid");
      await client.query(`UPDATE "${triggerTable}"
        SET "vm0_user_id" = "user_id"
        WHERE "phone_handle" = 'never-emit-phone-02'`);
      await client.query(
        `ALTER TABLE "${triggerTable}" ENABLE TRIGGER "${triggerName}"`,
      );

      await client.query(`DROP TRIGGER "${triggerName}" ON "${triggerTable}"`);
      await executeAndExpectDependencyDrift(testUrl, "triggers");
      await restoreSyncTrigger(client, triggerTable, triggerName);

      await client.query(
        `ALTER TABLE "${triggerTable}" DISABLE TRIGGER "${triggerName}"`,
      );
      await executeAndExpectDependencyDrift(testUrl, "triggers");
      await client.query(
        `ALTER TABLE "${triggerTable}" ENABLE TRIGGER "${triggerName}"`,
      );

      await client.query(`DROP TRIGGER "${triggerName}" ON "${triggerTable}"`);
      await client.query(`
        CREATE TRIGGER "${triggerName}"
        BEFORE INSERT ON "${triggerTable}"
        FOR EACH ROW EXECUTE FUNCTION "sync_integration_user_identity_0930"()
      `);
      await executeAndExpectDependencyDrift(testUrl, "triggers");
      await client.query(`DROP TRIGGER "${triggerName}" ON "${triggerTable}"`);
      await restoreSyncTrigger(client, triggerTable, triggerName);

      const functionDefinition = await client.query<{ definition: string }>(`
        SELECT pg_get_functiondef("function"."oid") AS "definition"
        FROM "pg_proc" AS "function"
        INNER JOIN "pg_namespace" AS "namespace"
          ON "namespace"."oid" = "function"."pronamespace"
        WHERE "namespace"."nspname" = 'public'
          AND "function"."proname" = 'sync_integration_user_identity_0930'
      `);
      const originalFunctionDefinition = functionDefinition.rows[0]?.definition;
      assert.ok(originalFunctionDefinition);
      await client.query(`
        CREATE OR REPLACE FUNCTION "sync_integration_user_identity_0930"()
        RETURNS trigger LANGUAGE plpgsql AS $body$
        BEGIN
          RETURN NEW;
        END;
        $body$
      `);
      await executeAndExpectDependencyDrift(testUrl, "functions");
      await client.query(originalFunctionDefinition);

      await client.query(`ALTER TABLE "agentphone_user_agent_preferences"
        DROP CONSTRAINT "agentphone_user_agent_preferences_pkey"`);
      await executeAndExpectDependencyDrift(testUrl, "primaryKeys");
      await client.query(`ALTER TABLE "agentphone_user_agent_preferences"
        ADD CONSTRAINT "agentphone_user_agent_preferences_pkey"
        PRIMARY KEY ("vm0_user_id", "org_id")`);

      await client.query(`ALTER TABLE "agentphone_user_links"
        ADD CONSTRAINT "preflight_unexpected_identity_check"
        CHECK ("vm0_user_id" <> 'never-emit-constraint-value')`);
      const constraintJson = await executeAndExpectDependencyDrift(
        testUrl,
        "constraints",
      );
      assert.equal(
        constraintJson.includes("never-emit-constraint-value"),
        false,
      );
      await client.query(`ALTER TABLE "agentphone_user_links"
        DROP CONSTRAINT "preflight_unexpected_identity_check"`);

      await client.query(`CREATE TABLE "preflight_identity_reference" (
        "vm0_user_id" text NOT NULL,
        "org_id" text NOT NULL,
        CONSTRAINT "preflight_unexpected_identity_foreign_key"
          FOREIGN KEY ("vm0_user_id", "org_id")
          REFERENCES "agentphone_user_agent_preferences" ("vm0_user_id", "org_id")
      )`);
      await executeAndExpectDependencyDrift(testUrl, "constraints");
      await client.query(`DROP TABLE "preflight_identity_reference"`);

      await client.query(`ALTER TABLE "agentphone_user_links"
        ALTER COLUMN "vm0_user_id" SET DEFAULT 'never-emit-default-value'`);
      const defaultJson = await executeAndExpectDependencyDrift(
        testUrl,
        "defaultsAndGenerated",
      );
      assert.equal(defaultJson.includes("never-emit-default-value"), false);
      await client.query(`ALTER TABLE "agentphone_user_links"
        ALTER COLUMN "vm0_user_id" DROP DEFAULT`);

      await client.query(`ALTER TABLE "agentphone_user_links"
        ADD COLUMN "preflight_generated_identity" text
        GENERATED ALWAYS AS ("vm0_user_id") STORED`);
      await executeAndExpectDependencyDrift(testUrl, "defaultsAndGenerated");
      await client.query(`ALTER TABLE "agentphone_user_links"
        DROP COLUMN "preflight_generated_identity"`);

      await client.query(`CREATE INDEX "preflight_unexpected_identity_index"
        ON "agentphone_user_links" ((lower("vm0_user_id")))`);
      await executeAndExpectDependencyDrift(testUrl, "indexes");
      await client.query(`DROP INDEX "preflight_unexpected_identity_index"`);

      await client.query(`CREATE VIEW "preflight_identity_view" AS
        SELECT "vm0_user_id" FROM "agentphone_user_links"`);
      await executeAndExpectDependencyDrift(testUrl, "rewriteDependents");
      await client.query(`DROP VIEW "preflight_identity_view"`);

      await client.query(`CREATE MATERIALIZED VIEW "preflight_identity_matview" AS
        SELECT "vm0_user_id" FROM "agentphone_user_links" WITH NO DATA`);
      await executeAndExpectDependencyDrift(testUrl, "rewriteDependents");
      await client.query(`DROP MATERIALIZED VIEW "preflight_identity_matview"`);

      await client.query(`CREATE RULE "preflight_identity_rule" AS
        ON UPDATE TO "agentphone_user_links"
        WHERE OLD."vm0_user_id" IS NOT NULL DO ALSO NOTHING`);
      await executeAndExpectDependencyDrift(testUrl, "rewriteDependents");
      await client.query(
        `DROP RULE "preflight_identity_rule" ON "agentphone_user_links"`,
      );

      await client.query(`CREATE SEQUENCE "preflight_identity_sequence"
        OWNED BY "agentphone_user_links"."vm0_user_id"`);
      await executeAndExpectDependencyDrift(testUrl, "otherDependents");
      await client.query(`DROP SEQUENCE "preflight_identity_sequence"`);

      const catalog = await client.query<CatalogDependencySourceRow>(
        CATALOG_DEPENDENCY_QUERY,
      );
      assert.equal(
        catalog.rows.filter((row) => {
          return row.kind === "columns";
        }).length,
        24,
      );
      const finalResult =
        await executeIntegrationIdentityContractReadinessPreflight({
          connectionString: testUrl,
        });
      assert.equal(finalResult.status, "passed");
      assert.equal(JSON.stringify(finalResult).includes("never-emit"), false);
    } finally {
      await client.end();
      await writer.end();
    }
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS "${testDatabase}" WITH (FORCE)`);
    await admin.end();
  }
}

export async function validateIntegrationIdentityContractReadinessPreflightStatic(): Promise<void> {
  testStaticClassification();
  await testRepositoryContracts();
}

export async function validateIntegrationIdentityContractReadinessPreflight(): Promise<void> {
  await validateIntegrationIdentityContractReadinessPreflightStatic();
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL is required");
  await testDatabaseBoundaries(databaseUrl);
  console.log("integration identity Contract readiness preflight passed");
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  validateIntegrationIdentityContractReadinessPreflight().catch(
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
