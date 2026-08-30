import assert from "node:assert/strict";
import { Client } from "pg";

function databaseErrorField(
  error: unknown,
  field: "code" | "constraint",
): string | undefined {
  if (typeof error !== "object" || error === null || !(field in error)) {
    return undefined;
  }
  const value = Reflect.get(error, field);
  return typeof value === "string" ? value : undefined;
}

export async function validatePermanentBuiltInProviderDiscriminatorState(
  dbUrl: string,
): Promise<void> {
  console.log(
    "=== Phase 2.5.1.2: Validate permanent built-in provider discriminator state ===\n",
  );
  const client = new Client({ connectionString: dbUrl });
  await client.connect();

  const ids = {
    run: "00000000-0000-4000-8000-000000299101",
    session: "00000000-0000-4000-8000-000000299102",
    thread: "00000000-0000-4000-8000-000000299103",
    policy: "00000000-0000-4000-8000-000000299104",
    defaultPolicy: "00000000-0000-4000-8000-000000299105",
    provider: "00000000-0000-4000-8000-000000299106",
    proposedProvider: "00000000-0000-4000-8000-000000299107",
    secondProposedProvider: "00000000-0000-4000-8000-000000299108",
    historicalProvider: "00000000-0000-4000-8000-000000299109",
    duplicateProvider: "00000000-0000-4000-8000-000000299110",
    invalidPolicy: "00000000-0000-4000-8000-000000299111",
    preexistingLegacyProvider: "00000000-0000-4000-8000-000000299112",
    preexistingLegacyProposedProvider: "00000000-0000-4000-8000-000000299113",
  } as const;
  const orgId = "org-provider-discriminator-permanent-29910";
  const userId = "user-provider-discriminator-permanent-29910";

  try {
    await client.query(
      `INSERT INTO "agent_sessions" ("id", "user_id", "org_id") VALUES ($1, $2, $3)`,
      [ids.session, userId, orgId],
    );

    const run = await client.query<{ id: string; type: string }>(
      `
        INSERT INTO "agent_runs" (
          "id", "user_id", "org_id", "session_id", "status", "prompt",
          "trigger_source", "autonomy_budget", "model_provider"
        ) VALUES ($1, $2, $3, $4, 'pending', 'old app/new DB run', 'chat', 0, 'vm0')
        RETURNING "id"::text AS "id", "model_provider" AS "type"
      `,
      [ids.run, userId, orgId, ids.session],
    );
    assert.deepEqual(run.rows, [{ id: ids.run, type: "built-in" }]);

    const thread = await client.query<{ id: string; type: string }>(
      `
        INSERT INTO "chat_threads" ("id", "user_id", "model_provider_type")
        VALUES ($1, $2, 'vm0')
        RETURNING "id"::text AS "id", "model_provider_type" AS "type"
      `,
      [ids.thread, userId],
    );
    assert.deepEqual(thread.rows, [{ id: ids.thread, type: "built-in" }]);

    const policy = await client.query<{ id: string; type: string }>(
      `
        INSERT INTO "org_model_policies" (
          "id", "org_id", "model", "default_provider_type"
        ) VALUES ($1, $2, 'gpt-5.6-sol', 'vm0')
        RETURNING "id"::text AS "id", "default_provider_type" AS "type"
      `,
      [ids.policy, orgId],
    );
    assert.deepEqual(policy.rows, [{ id: ids.policy, type: "built-in" }]);

    const defaultPolicy = await client.query<{ id: string; type: string }>(
      `
        INSERT INTO "org_model_policies" ("id", "org_id", "model")
        VALUES ($1, $2, 'gpt-5.6-luna')
        RETURNING "id"::text AS "id", "default_provider_type" AS "type"
      `,
      [ids.defaultPolicy, orgId],
    );
    assert.deepEqual(defaultPolicy.rows, [
      { id: ids.defaultPolicy, type: "built-in" },
    ]);

    await client.query(
      `ALTER TABLE "model_providers" DISABLE TRIGGER "canonicalize_model_provider_builtin_type"`,
    );
    try {
      await client.query(
        `
          INSERT INTO "model_providers" (
            "id", "org_id", "user_id", "type", "selected_model"
          ) VALUES ($1, $2, 'preexisting-legacy-provider-user-29910', 'vm0', 'gpt-5.6-luna')
        `,
        [ids.preexistingLegacyProvider, orgId],
      );
    } finally {
      await client.query(
        `ALTER TABLE "model_providers" ENABLE TRIGGER "canonicalize_model_provider_builtin_type"`,
      );
    }

    const preexistingLegacyUpsert = await client.query<{
      id: string;
      type: string;
    }>(
      `
        INSERT INTO "model_providers" (
          "id", "org_id", "user_id", "type", "selected_model"
        ) VALUES ($1, $2, 'preexisting-legacy-provider-user-29910', 'vm0', 'gpt-5.6-sol')
        ON CONFLICT ("org_id", "user_id", "type") DO UPDATE
        SET "selected_model" = EXCLUDED."selected_model"
        RETURNING "id"::text AS "id", "type"
      `,
      [ids.preexistingLegacyProposedProvider, orgId],
    );
    assert.deepEqual(preexistingLegacyUpsert.rows, [
      { id: ids.preexistingLegacyProvider, type: "built-in" },
    ]);

    const legacyUpsert = await client.query<{ id: string; type: string }>(
      `
        INSERT INTO "model_providers" (
          "id", "org_id", "user_id", "type", "selected_model"
        ) VALUES ($1, $2, $3, 'vm0', 'gpt-5.6-luna')
        ON CONFLICT ("org_id", "user_id", "type") DO UPDATE
        SET "selected_model" = EXCLUDED."selected_model"
        RETURNING "id"::text AS "id", "type"
      `,
      [ids.provider, orgId, userId],
    );
    assert.deepEqual(legacyUpsert.rows, [
      { id: ids.provider, type: "built-in" },
    ]);

    const canonicalUpsert = await client.query<{ id: string; type: string }>(
      `
        INSERT INTO "model_providers" (
          "id", "org_id", "user_id", "type", "selected_model"
        ) VALUES ($1, $2, $3, 'built-in', 'gpt-5.6-sol')
        ON CONFLICT ("org_id", "user_id", "type") DO UPDATE
        SET "selected_model" = EXCLUDED."selected_model"
        RETURNING "id"::text AS "id", "type"
      `,
      [ids.proposedProvider, orgId, userId],
    );
    assert.deepEqual(canonicalUpsert.rows, [
      { id: ids.provider, type: "built-in" },
    ]);

    const secondLegacyUpsert = await client.query<{
      id: string;
      type: string;
    }>(
      `
        INSERT INTO "model_providers" (
          "id", "org_id", "user_id", "type", "selected_model"
        ) VALUES ($1, $2, $3, 'vm0', 'gpt-5.6-terra')
        ON CONFLICT ("org_id", "user_id", "type") DO UPDATE
        SET "selected_model" = EXCLUDED."selected_model"
        RETURNING "id"::text AS "id", "type"
      `,
      [ids.secondProposedProvider, orgId, userId],
    );
    assert.deepEqual(secondLegacyUpsert.rows, [
      { id: ids.provider, type: "built-in" },
    ]);

    const providerIdentity = await client.query<{
      count: number;
      id: string;
      selectedModel: string;
      type: string;
    }>(
      `
        SELECT
          count(*) OVER ()::integer AS "count",
          "id"::text AS "id",
          "selected_model" AS "selectedModel",
          "type"
        FROM "model_providers"
        WHERE "org_id" = $1 AND "user_id" = $2
          AND "type" IN ('vm0', 'built-in')
      `,
      [orgId, userId],
    );
    assert.deepEqual(providerIdentity.rows, [
      {
        count: 1,
        id: ids.provider,
        selectedModel: "gpt-5.6-terra",
        type: "built-in",
      },
    ]);

    await client.query(
      `
        INSERT INTO "model_providers" ("id", "org_id", "user_id", "type")
        VALUES ($1, $2, $3, 'VM0')
      `,
      [ids.historicalProvider, orgId, "historical-provider-user-29910"],
    );
    const historical = await client.query<{ type: string }>(
      `SELECT "type" FROM "model_providers" WHERE "id" = $1`,
      [ids.historicalProvider],
    );
    assert.deepEqual(historical.rows, [{ type: "VM0" }]);

    await assert.rejects(
      client.query(
        `
          INSERT INTO "model_providers" ("id", "org_id", "user_id", "type")
          VALUES ($1, $2, $3, 'vm0')
        `,
        [ids.duplicateProvider, orgId, userId],
      ),
      (error: unknown) => {
        return (
          databaseErrorField(error, "code") === "23505" &&
          databaseErrorField(error, "constraint") ===
            "idx_model_providers_org_user_type"
        );
      },
    );

    await assert.rejects(
      client.query(
        `
          INSERT INTO "org_model_policies" (
            "id", "org_id", "model", "default_provider_type",
            "model_provider_id"
          ) VALUES ($1, $2, 'gpt-5.5', 'vm0', $3)
        `,
        [ids.invalidPolicy, orgId, ids.provider],
      ),
      (error: unknown) => {
        return (
          databaseErrorField(error, "code") === "23514" &&
          databaseErrorField(error, "constraint") ===
            "chk_org_model_policies_builtin_route_no_provider_id"
        );
      },
    );

    const schemaState = await client.query<{
      constraintDefinition: string;
      defaultExpression: string;
    }>(`
      SELECT
        pg_get_constraintdef("constraint"."oid") AS "constraintDefinition",
        pg_get_expr("attribute_default"."adbin", "attribute_default"."adrelid") AS "defaultExpression"
      FROM "pg_constraint" AS "constraint"
      JOIN "pg_class" AS "relation"
        ON "relation"."oid" = "constraint"."conrelid"
      JOIN "pg_attribute" AS "attribute"
        ON "attribute"."attrelid" = "relation"."oid"
        AND "attribute"."attname" = 'default_provider_type'
      JOIN "pg_attrdef" AS "attribute_default"
        ON "attribute_default"."adrelid" = "relation"."oid"
        AND "attribute_default"."adnum" = "attribute"."attnum"
      WHERE "relation"."relname" = 'org_model_policies'
        AND "constraint"."conname" = 'chk_org_model_policies_builtin_route_no_provider_id'
    `);
    assert.equal(schemaState.rows.length, 1);
    assert.match(schemaState.rows[0]?.defaultExpression ?? "", /built-in/u);
    assert.match(
      schemaState.rows[0]?.constraintDefinition ?? "",
      /default_provider_type.*built-in/u,
    );
    assert.doesNotMatch(
      schemaState.rows[0]?.constraintDefinition ?? "",
      /default_provider_type.*vm0/u,
    );

    console.log(
      "   ✅ old-app SQL is canonicalized on all four persisted surfaces",
    );
    console.log(
      "   ✅ pre-existing vm0 plus alternating alias upserts retain one model_providers row and its original id",
    );
    console.log(
      "   ✅ exact-value matching preserves other historical provider spellings",
    );
    console.log(
      "   ✅ canonical default/check semantics and the rollback bridge remain enforced\n",
    );
  } finally {
    await client.query(`DELETE FROM "org_model_policies" WHERE "org_id" = $1`, [
      orgId,
    ]);
    await client.query(`DELETE FROM "chat_threads" WHERE "user_id" = $1`, [
      userId,
    ]);
    await client.query(`DELETE FROM "model_providers" WHERE "org_id" = $1`, [
      orgId,
    ]);
    await client.query(`DELETE FROM "agent_sessions" WHERE "id" = $1`, [
      ids.session,
    ]);
    await client.end();
  }
}
