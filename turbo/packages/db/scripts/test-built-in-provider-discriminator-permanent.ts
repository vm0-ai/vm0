import assert from "node:assert/strict";
import { upsertBuiltInNoSecretModelProviderIdentity } from "@okouai/db/operations/model-provider-built-in-identity";
import { drizzle } from "drizzle-orm/node-postgres";
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

function databaseErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const code = Reflect.get(error, "code");
  if (typeof code === "string") {
    return code;
  }
  return databaseErrorCode(Reflect.get(error, "cause"));
}

export async function validatePermanentBuiltInProviderDiscriminatorState(
  dbUrl: string,
): Promise<void> {
  console.log(
    "=== Phase 2.5.1.2: Validate permanent built-in provider discriminator state ===\n",
  );
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  const db = drizzle(client);

  const ids = {
    run: "00000000-0000-4000-8000-000000299101",
    session: "00000000-0000-4000-8000-000000299102",
    thread: "00000000-0000-4000-8000-000000299103",
    policy: "00000000-0000-4000-8000-000000299104",
    defaultPolicy: "00000000-0000-4000-8000-000000299105",
    provider: "00000000-0000-4000-8000-000000299106",
    proposedProvider: "00000000-0000-4000-8000-000000299107",
    historicalProvider: "00000000-0000-4000-8000-000000299108",
    invalidPolicy: "00000000-0000-4000-8000-000000299109",
    helperProvider: "00000000-0000-4000-8000-000000310840",
    helperLockProbeProvider: "00000000-0000-4000-8000-000000310841",
    helperUpdateProvider: "00000000-0000-4000-8000-000000310842",
    helperRepeatedProvider: "00000000-0000-4000-8000-000000310843",
  } as const;
  const orgId = "org-provider-discriminator-permanent-30671";
  const helperOrgId = "org-provider-identity-permanent-31084";
  const userId = "user-provider-discriminator-permanent-30671";

  try {
    const residuals = await client.query<{ count: number }>(`
      SELECT (
        (SELECT count(*) FROM "agent_runs" WHERE "model_provider" = 'vm0') +
        (SELECT count(*) FROM "chat_threads" WHERE "model_provider_type" = 'vm0') +
        (SELECT count(*) FROM "org_model_policies" WHERE "default_provider_type" = 'vm0') +
        (SELECT count(*) FROM "model_providers" WHERE "type" = 'vm0')
      )::integer AS "count"
    `);
    assert.deepEqual(residuals.rows, [{ count: 0 }]);

    const bridgeObjects = await client.query<{ count: number }>(`
      SELECT (
        (
          SELECT count(*)
          FROM "pg_trigger"
          WHERE "tgname" IN (
            'canonicalize_agent_run_builtin_provider',
            'canonicalize_chat_thread_builtin_provider',
            'canonicalize_model_provider_builtin_type',
            'canonicalize_org_model_policy_builtin_provider'
          )
            AND NOT "tgisinternal"
        ) + (
          SELECT count(*)
          FROM "pg_proc" AS "function"
          JOIN "pg_namespace" AS "namespace"
            ON "namespace"."oid" = "function"."pronamespace"
          WHERE "namespace"."nspname" = 'public'
            AND "function"."proname" IN (
              'canonicalize_agent_run_builtin_provider',
              'canonicalize_chat_thread_builtin_provider',
              'canonicalize_model_provider_builtin_type',
              'canonicalize_org_model_policy_builtin_provider'
            )
        )
      )::integer AS "count"
    `);
    assert.deepEqual(bridgeObjects.rows, [{ count: 0 }]);

    await client.query(
      `INSERT INTO "agent_sessions" ("id", "user_id", "org_id") VALUES ($1, $2, $3)`,
      [ids.session, userId, orgId],
    );

    const run = await client.query<{ id: string; type: string }>(
      `
        INSERT INTO "agent_runs" (
          "id", "user_id", "org_id", "session_id", "status", "prompt",
          "trigger_source", "autonomy_budget", "model_provider"
        ) VALUES ($1, $2, $3, $4, 'pending', 'canonical run', 'chat', 0, 'built-in')
        RETURNING "id"::text AS "id", "model_provider" AS "type"
      `,
      [ids.run, userId, orgId, ids.session],
    );
    assert.deepEqual(run.rows, [{ id: ids.run, type: "built-in" }]);

    const thread = await client.query<{ id: string; type: string }>(
      `
        INSERT INTO "chat_threads" ("id", "user_id", "model_provider_type")
        VALUES ($1, $2, 'built-in')
        RETURNING "id"::text AS "id", "model_provider_type" AS "type"
      `,
      [ids.thread, userId],
    );
    assert.deepEqual(thread.rows, [{ id: ids.thread, type: "built-in" }]);

    const policy = await client.query<{ id: string; type: string }>(
      `
        INSERT INTO "org_model_policies" (
          "id", "org_id", "model", "default_provider_type"
        ) VALUES ($1, $2, 'gpt-5.6-sol', 'built-in')
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

    const canonicalInsert = await client.query<{ id: string; type: string }>(
      `
        INSERT INTO "model_providers" (
          "id", "org_id", "user_id", "type", "selected_model"
        ) VALUES ($1, $2, $3, 'built-in', 'gpt-5.6-luna')
        RETURNING "id"::text AS "id", "type"
      `,
      [ids.provider, orgId, userId],
    );
    assert.deepEqual(canonicalInsert.rows, [
      { id: ids.provider, type: "built-in" },
    ]);

    const canonicalUpsert = await client.query<{
      id: string;
      selectedModel: string;
      type: string;
    }>(
      `
        INSERT INTO "model_providers" (
          "id", "org_id", "user_id", "type", "selected_model"
        ) VALUES ($1, $2, $3, 'built-in', 'gpt-5.6-sol')
        ON CONFLICT ("org_id", "user_id", "type") DO UPDATE
        SET "selected_model" = EXCLUDED."selected_model"
        RETURNING
          "id"::text AS "id",
          "selected_model" AS "selectedModel",
          "type"
      `,
      [ids.proposedProvider, orgId, userId],
    );
    assert.deepEqual(canonicalUpsert.rows, [
      {
        id: ids.provider,
        selectedModel: "gpt-5.6-sol",
        type: "built-in",
      },
    ]);

    await client.query(
      `
        INSERT INTO "model_providers" ("id", "org_id", "user_id", "type")
        VALUES ($1, $2, $3, 'VM0')
      `,
      [ids.historicalProvider, orgId, "historical-provider-user-30671"],
    );
    const historical = await client.query<{ type: string }>(
      `SELECT "type" FROM "model_providers" WHERE "id" = $1`,
      [ids.historicalProvider],
    );
    assert.deepEqual(historical.rows, [{ type: "VM0" }]);

    await assert.rejects(
      client.query(
        `
          INSERT INTO "org_model_policies" (
            "id", "org_id", "model", "default_provider_type",
            "model_provider_id"
          ) VALUES ($1, $2, 'gpt-5.5', 'built-in', $3)
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

    const indexState = await client.query<{ count: number }>(`
      SELECT count(*)::integer AS "count"
      FROM "pg_index" AS "index"
      JOIN "pg_class" AS "relation"
        ON "relation"."oid" = "index"."indexrelid"
      WHERE "index"."indrelid" = 'public.model_providers'::regclass
        AND "relation"."relname" = 'idx_model_providers_org_user_type'
        AND "index"."indisunique"
        AND "index"."indpred" IS NULL
        AND pg_get_indexdef("index"."indexrelid") = 'CREATE UNIQUE INDEX idx_model_providers_org_user_type ON public.model_providers USING btree (org_id, user_id, type)'
    `);
    assert.deepEqual(indexState.rows, [{ count: 1 }]);

    const created = await upsertBuiltInNoSecretModelProviderIdentity(
      db,
      {
        orgId: helperOrgId,
        selectedModel: "gpt-5.6-sol",
        updatedAt: new Date("2026-09-02T00:00:00.000Z"),
        proposedId: ids.helperProvider,
      },
      new AbortController().signal,
    );
    assert.equal(created.created, true);
    assert.equal(created.provider.id, ids.helperProvider);
    assert.equal(created.provider.type, "built-in");
    assert.equal(created.provider.selectedModel, "gpt-5.6-sol");

    const lockClient = new Client({ connectionString: dbUrl });
    await lockClient.connect();
    try {
      await lockClient.query("BEGIN");
      await lockClient.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `model_provider_state:${helperOrgId}:__org__:built-in`,
      ]);
      await client.query("SET lock_timeout = '100ms'");
      try {
        await assert.rejects(
          upsertBuiltInNoSecretModelProviderIdentity(
            db,
            {
              orgId: helperOrgId,
              selectedModel: "gpt-5.6-terra",
              updatedAt: new Date("2026-09-02T00:01:00.000Z"),
              proposedId: ids.helperLockProbeProvider,
            },
            new AbortController().signal,
          ),
          (error: unknown) => {
            return databaseErrorCode(error) === "55P03";
          },
        );
      } finally {
        await client.query("RESET lock_timeout");
        await lockClient.query("ROLLBACK");
      }
    } finally {
      await lockClient.end();
    }

    const afterLockProbe = await client.query<{
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
        WHERE "org_id" = $1 AND "user_id" = '__org__'
      `,
      [helperOrgId],
    );
    assert.deepEqual(afterLockProbe.rows, [
      {
        count: 1,
        id: ids.helperProvider,
        selectedModel: "gpt-5.6-sol",
        type: "built-in",
      },
    ]);

    const updated = await upsertBuiltInNoSecretModelProviderIdentity(
      db,
      {
        orgId: helperOrgId,
        selectedModel: "gpt-5.6-terra",
        updatedAt: new Date("2026-09-02T00:02:00.000Z"),
        proposedId: ids.helperUpdateProvider,
      },
      new AbortController().signal,
    );
    assert.equal(updated.created, false);
    assert.equal(updated.provider.id, ids.helperProvider);
    assert.equal(updated.provider.type, "built-in");
    assert.equal(updated.provider.selectedModel, "gpt-5.6-terra");

    const repeated = await upsertBuiltInNoSecretModelProviderIdentity(
      db,
      {
        orgId: helperOrgId,
        selectedModel: "gpt-5.6-luna",
        updatedAt: new Date("2026-09-02T00:03:00.000Z"),
        proposedId: ids.helperRepeatedProvider,
      },
      new AbortController().signal,
    );
    assert.equal(repeated.created, false);
    assert.equal(repeated.provider.id, ids.helperProvider);
    assert.equal(repeated.provider.type, "built-in");
    assert.equal(repeated.provider.selectedModel, "gpt-5.6-luna");

    console.log(
      "   ✅ permanent data and catalog state contain no exact vm0 discriminator or rollback bridge",
    );
    console.log(
      "   ✅ canonical built-in inserts, defaults, checks, and identity-preserving upserts remain enforced",
    );
    console.log(
      "   ✅ exact-value contraction preserves other historical provider spellings\n",
    );
    console.log(
      "   ✅ active helper preserves canonical creation, locking, update, repeated-upsert, and row identity semantics\n",
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
    await client.query(`DELETE FROM "model_providers" WHERE "org_id" = $1`, [
      helperOrgId,
    ]);
    await client.query(`DELETE FROM "agent_sessions" WHERE "id" = $1`, [
      ids.session,
    ]);
    await client.end();
  }
}
