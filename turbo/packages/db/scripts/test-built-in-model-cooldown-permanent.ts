import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

interface CooldownRow {
  readonly connectionObservationRunId?: string | null;
  readonly connectionObservationUntil?: Date | null;
  readonly providerType: string;
  readonly selectedModel: string;
  readonly unavailableUntil: Date;
  readonly upstreamModel: string;
}

interface ColumnRow {
  readonly characterMaximumLength: number | null;
  readonly columnName: string;
  readonly dataType: string;
  readonly isNullable: "NO" | "YES";
}

const fixture = {
  baseline: {
    providerType: "permanent-provider-baseline",
    selectedModel: "permanent-built-in-model-cooldown-baseline",
    upstreamModel: "permanent-upstream-baseline",
  },
  statement: {
    providerType: "permanent-provider-statements",
    selectedModel: "permanent-built-in-model-cooldown-statements",
    upstreamModel: "permanent-upstream-statements",
  },
  observation: {
    providerType: "permanent-provider-observation",
    selectedModel: "permanent-built-in-model-cooldown-observation",
    upstreamModel: "permanent-upstream-observation",
  },
} as const;

async function readFixture(
  client: Client,
  identity: {
    readonly providerType: string;
    readonly selectedModel: string;
    readonly upstreamModel: string;
  },
): Promise<readonly CooldownRow[]> {
  const result = await client.query<CooldownRow>(
    `
      SELECT
        "selected_model" AS "selectedModel",
        "provider_type" AS "providerType",
        "upstream_model" AS "upstreamModel",
        "unavailable_until" AS "unavailableUntil",
        "connection_observation_run_id" AS "connectionObservationRunId",
        "connection_observation_until" AS "connectionObservationUntil"
      FROM "built_in_model_candidate_cooldown"
      WHERE "selected_model" = $1
        AND "provider_type" = $2
        AND "upstream_model" = $3
    `,
    [identity.selectedModel, identity.providerType, identity.upstreamModel],
  );
  return result.rows;
}

async function assertCanonicalSchema(client: Client): Promise<void> {
  const relations = await client.query<{
    canonicalRelation: string | null;
    legacyRelation: string | null;
  }>(`
    SELECT
      to_regclass('public.built_in_model_candidate_cooldown')::text
        AS "canonicalRelation",
      to_regclass('public.managed_model_candidate_cooldown')::text
        AS "legacyRelation"
  `);
  assert.deepEqual(relations.rows, [
    {
      canonicalRelation: "built_in_model_candidate_cooldown",
      legacyRelation: null,
    },
  ]);

  const columns = await client.query<ColumnRow>(`
    SELECT
      "column_name" AS "columnName",
      "data_type" AS "dataType",
      "is_nullable" AS "isNullable",
      "character_maximum_length" AS "characterMaximumLength"
    FROM "information_schema"."columns"
    WHERE "table_schema" = 'public'
      AND "table_name" = 'built_in_model_candidate_cooldown'
    ORDER BY "ordinal_position"
  `);
  assert.deepEqual(columns.rows, [
    {
      characterMaximumLength: 255,
      columnName: "selected_model",
      dataType: "character varying",
      isNullable: "NO",
    },
    {
      characterMaximumLength: 100,
      columnName: "provider_type",
      dataType: "character varying",
      isNullable: "NO",
    },
    {
      characterMaximumLength: 255,
      columnName: "upstream_model",
      dataType: "character varying",
      isNullable: "NO",
    },
    {
      characterMaximumLength: null,
      columnName: "unavailable_until",
      dataType: "timestamp without time zone",
      isNullable: "NO",
    },
    {
      characterMaximumLength: null,
      columnName: "connection_observation_run_id",
      dataType: "uuid",
      isNullable: "YES",
    },
    {
      characterMaximumLength: null,
      columnName: "connection_observation_until",
      dataType: "timestamp without time zone",
      isNullable: "YES",
    },
  ]);

  const checkConstraints = await client.query<{ constraintName: string }>(`
    SELECT "constraint"."conname" AS "constraintName"
    FROM "pg_constraint" AS "constraint"
    INNER JOIN "pg_class" AS "relation"
      ON "relation"."oid" = "constraint"."conrelid"
    WHERE "relation"."relname" = 'built_in_model_candidate_cooldown'
      AND "constraint"."contype" = 'c'
    ORDER BY "constraint"."conname"
  `);
  assert.deepEqual(checkConstraints.rows, [
    {
      constraintName: "built_in_model_cooldown_observation_pair_check",
    },
  ]);

  const primaryKey = await client.query<{ columnName: string }>(`
    SELECT "attribute"."attname" AS "columnName"
    FROM "pg_constraint" AS "constraint"
    INNER JOIN "pg_class" AS "relation"
      ON "relation"."oid" = "constraint"."conrelid"
    INNER JOIN LATERAL unnest("constraint"."conkey") WITH ORDINALITY
      AS "key_column"("attribute_number", "position") ON TRUE
    INNER JOIN "pg_attribute" AS "attribute"
      ON "attribute"."attrelid" = "relation"."oid"
      AND "attribute"."attnum" = "key_column"."attribute_number"
    WHERE "relation"."relname" = 'built_in_model_candidate_cooldown'
      AND "constraint"."contype" = 'p'
    ORDER BY "key_column"."position"
  `);
  assert.deepEqual(
    primaryKey.rows.map((row) => {
      return row.columnName;
    }),
    ["selected_model", "provider_type", "upstream_model"],
  );
}

async function validateCanonicalStatements(client: Client): Promise<void> {
  const baselineDeadline = new Date("2026-08-25T05:00:00.000Z");
  const initialDeadline = new Date("2026-08-25T07:00:00.000Z");
  const earlierDeadline = new Date("2026-08-25T06:00:00.000Z");
  const laterDeadline = new Date("2026-08-25T08:00:00.000Z");

  await client.query(
    `
      INSERT INTO "built_in_model_candidate_cooldown" (
        "selected_model", "provider_type", "upstream_model", "unavailable_until"
      )
      VALUES ($1, $2, $3, $4)
    `,
    [
      fixture.baseline.selectedModel,
      fixture.baseline.providerType,
      fixture.baseline.upstreamModel,
      baselineDeadline,
    ],
  );

  const upsert = async (deadline: Date): Promise<readonly CooldownRow[]> => {
    const result = await client.query<CooldownRow>(
      `
        INSERT INTO "built_in_model_candidate_cooldown" (
          "selected_model", "provider_type", "upstream_model", "unavailable_until"
        )
        VALUES ($1, $2, $3, $4)
        ON CONFLICT ("selected_model", "provider_type", "upstream_model")
        DO UPDATE SET
          "unavailable_until" = GREATEST(
            "built_in_model_candidate_cooldown"."unavailable_until",
            EXCLUDED."unavailable_until"
          )
        RETURNING
          "selected_model" AS "selectedModel",
          "provider_type" AS "providerType",
          "upstream_model" AS "upstreamModel",
          "unavailable_until" AS "unavailableUntil"
      `,
      [
        fixture.statement.selectedModel,
        fixture.statement.providerType,
        fixture.statement.upstreamModel,
        deadline,
      ],
    );
    return result.rows;
  };

  assert.equal(
    (await upsert(initialDeadline))[0]?.unavailableUntil.getTime(),
    initialDeadline.getTime(),
  );
  assert.equal(
    (await upsert(earlierDeadline))[0]?.unavailableUntil.getTime(),
    initialDeadline.getTime(),
  );
  assert.equal(
    (await upsert(laterDeadline))[0]?.unavailableUntil.getTime(),
    laterDeadline.getTime(),
  );

  const active = await client.query<CooldownRow>(
    `
      SELECT
        "selected_model" AS "selectedModel",
        "provider_type" AS "providerType",
        "upstream_model" AS "upstreamModel",
        "unavailable_until" AS "unavailableUntil"
      FROM "built_in_model_candidate_cooldown"
      WHERE "selected_model" = $1
        AND "provider_type" = $2
        AND "upstream_model" = $3
        AND "unavailable_until" > $4
    `,
    [
      fixture.statement.selectedModel,
      fixture.statement.providerType,
      fixture.statement.upstreamModel,
      initialDeadline,
    ],
  );
  assert.equal(
    active.rows[0]?.unavailableUntil.getTime(),
    laterDeadline.getTime(),
  );

  const deleted = await client.query<CooldownRow>(
    `
      DELETE FROM "built_in_model_candidate_cooldown"
      WHERE "selected_model" = $1
        AND "provider_type" = $2
        AND "upstream_model" = $3
      RETURNING
        "selected_model" AS "selectedModel",
        "provider_type" AS "providerType",
        "upstream_model" AS "upstreamModel",
        "unavailable_until" AS "unavailableUntil"
    `,
    [
      fixture.statement.selectedModel,
      fixture.statement.providerType,
      fixture.statement.upstreamModel,
    ],
  );
  assert.deepEqual(deleted.rows, active.rows);
  assert.equal(
    (
      await readFixture(client, fixture.baseline)
    )[0]?.unavailableUntil.getTime(),
    baselineDeadline.getTime(),
  );
}

async function validateObservationStatements(client: Client): Promise<void> {
  const inactiveDeadline = new Date("1970-01-01T00:00:00.000Z");
  const observationUntil = new Date("2026-08-25T09:00:00.000Z");
  const observationRunId = "00000000-0000-4000-8000-000000000001";

  await assert.rejects(
    client.query(
      `
        INSERT INTO "built_in_model_candidate_cooldown" (
          "selected_model",
          "provider_type",
          "upstream_model",
          "unavailable_until",
          "connection_observation_run_id"
        )
        VALUES ($1, $2, $3, $4, $5)
      `,
      [
        fixture.observation.selectedModel,
        fixture.observation.providerType,
        fixture.observation.upstreamModel,
        inactiveDeadline,
        observationRunId,
      ],
    ),
    { code: "23514" },
  );

  await client.query(
    `
      INSERT INTO "built_in_model_candidate_cooldown" (
        "selected_model",
        "provider_type",
        "upstream_model",
        "unavailable_until",
        "connection_observation_run_id",
        "connection_observation_until"
      )
      VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [
      fixture.observation.selectedModel,
      fixture.observation.providerType,
      fixture.observation.upstreamModel,
      inactiveDeadline,
      observationRunId,
      observationUntil,
    ],
  );
  assert.deepEqual(await readFixture(client, fixture.observation), [
    {
      selectedModel: fixture.observation.selectedModel,
      providerType: fixture.observation.providerType,
      upstreamModel: fixture.observation.upstreamModel,
      unavailableUntil: inactiveDeadline,
      connectionObservationRunId: observationRunId,
      connectionObservationUntil: observationUntil,
    },
  ]);

  await client.query(
    `
      UPDATE "built_in_model_candidate_cooldown"
      SET
        "connection_observation_run_id" = NULL,
        "connection_observation_until" = NULL
      WHERE "selected_model" = $1
        AND "provider_type" = $2
        AND "upstream_model" = $3
    `,
    [
      fixture.observation.selectedModel,
      fixture.observation.providerType,
      fixture.observation.upstreamModel,
    ],
  );
  assert.deepEqual(await readFixture(client, fixture.observation), [
    {
      selectedModel: fixture.observation.selectedModel,
      providerType: fixture.observation.providerType,
      upstreamModel: fixture.observation.upstreamModel,
      unavailableUntil: inactiveDeadline,
      connectionObservationRunId: null,
      connectionObservationUntil: null,
    },
  ]);
}

export async function validatePermanentBuiltInModelCooldownState(
  databaseUrl: string,
): Promise<void> {
  console.log("=== Validate permanent built-in model cooldown state ===\n");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await assertCanonicalSchema(client);
    await validateCanonicalStatements(client);
    await validateObservationStatements(client);

    console.log("   ✅ only the canonical cooldown relation exists");
    console.log("   ✅ canonical columns and primary key are stable");
    console.log("   ✅ current statements preserve monotonic deadlines\n");
    console.log("   ✅ observation pairs can be written and cleared\n");
  } finally {
    await client.query(
      `
        DELETE FROM "built_in_model_candidate_cooldown"
        WHERE "selected_model" IN ($1, $2, $3)
      `,
      [
        fixture.baseline.selectedModel,
        fixture.statement.selectedModel,
        fixture.observation.selectedModel,
      ],
    );
    await client.end();
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  const databaseUrl = process.env.DATABASE_URL;
  assert.ok(databaseUrl, "DATABASE_URL is required");
  validatePermanentBuiltInModelCooldownState(databaseUrl).catch(
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
