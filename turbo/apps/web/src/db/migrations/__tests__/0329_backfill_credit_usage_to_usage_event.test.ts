import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { env } from "../../../env";
import { initServices } from "../../../lib/init-services";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { creditPricing } from "@vm0/db/schema/credit-pricing";
import { creditUsage } from "@vm0/db/schema/credit-usage";
import { usageEvent } from "@vm0/db/schema/usage-event";

const MODEL_USAGE_EVENT_NAMESPACE = "18a22204-d25e-4170-8973-86477f864bfb";
const MIGRATION_SQL = readFileSync(
  new URL("../0329_backfill_credit_usage_to_usage_event.sql", import.meta.url),
  "utf8",
);
const MIGRATION_STATEMENTS = MIGRATION_SQL.split("--> statement-breakpoint")
  .map((statement) => {
    return statement.trim();
  })
  .filter(Boolean);
const ROLLBACK_TEST_TRANSACTION = new Error("rollback test transaction");

function encodeUuidName(parts: string[]): Buffer {
  const chunks: Buffer[] = [];
  for (const [index, part] of parts.entries()) {
    const partBytes = Buffer.from(part, "utf8");
    chunks.push(Buffer.from(`${partBytes.byteLength}:`, "utf8"), partBytes);
    if (index < parts.length - 1) {
      chunks.push(Buffer.from([0]));
    }
  }
  return Buffer.concat(chunks);
}

function uuidV5(namespace: string, nameBytes: Buffer): string {
  const namespaceBytes = Buffer.from(namespace.replaceAll("-", ""), "hex");
  const hash = createHash("sha1")
    .update(Buffer.concat([namespaceBytes, nameBytes]))
    .digest()
    .subarray(0, 16);

  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;

  const hex = hash.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function expectedIdempotencyKey(parts: string[]): string {
  return uuidV5(MODEL_USAGE_EVENT_NAMESPACE, encodeUuidName(parts));
}

function testIdentity(): { orgId: string; userId: string } {
  const suffix = randomUUID().slice(0, 8);
  return {
    orgId: `test-org-${suffix}`,
    userId: `test-user-${suffix}`,
  };
}

async function runMigrationStatements(
  tx: postgres.TransactionSql,
): Promise<void> {
  for (const statement of MIGRATION_STATEMENTS) {
    await tx.unsafe(statement);
  }
}

async function runMigrationForOrg(orgId: string): Promise<void> {
  const databaseUrl = env().DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const client = postgres(databaseUrl, { max: 1 });
  try {
    await client.begin(async (tx) => {
      await tx`SELECT set_config('vm0.credit_usage_backfill_org_id', ${orgId}, true)`;
      await runMigrationStatements(tx);
    });
  } finally {
    await client.end();
  }
}

async function withCleanCreditUsageTransaction(
  callback: (tx: postgres.TransactionSql) => Promise<void>,
): Promise<void> {
  const databaseUrl = env().DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const client = postgres(databaseUrl, { max: 1 });
  try {
    try {
      await client.begin("isolation level repeatable read", async (tx) => {
        // Isolate unscoped migration tests from stale source rows in the shared test DB.
        await tx`DELETE FROM credit_usage`;
        await callback(tx);
        throw ROLLBACK_TEST_TRANSACTION;
      });
    } catch (error) {
      if (error !== ROLLBACK_TEST_TRANSACTION) {
        throw error;
      }
    }
  } finally {
    await client.end();
  }
}

async function insertCreditPricing(params: {
  model: string;
  modelProvider?: string;
  inputTokenPrice?: number;
  outputTokenPrice?: number;
  cacheReadTokenPrice?: number;
  cacheCreationTokenPrice?: number;
}): Promise<void> {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: needs services initialised for direct DB setup
  initServices();
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: seeds pricing reference data
  await globalThis.services.db
    .insert(creditPricing)
    .values({
      model: params.model,
      modelProvider: params.modelProvider ?? "",
      inputTokenPrice: params.inputTokenPrice ?? 100,
      outputTokenPrice: params.outputTokenPrice ?? 200,
      cacheReadTokenPrice: params.cacheReadTokenPrice ?? 0,
      cacheCreationTokenPrice: params.cacheCreationTokenPrice ?? 0,
    })
    .onConflictDoUpdate({
      target: [creditPricing.model, creditPricing.modelProvider],
      set: {
        inputTokenPrice: params.inputTokenPrice ?? 100,
        outputTokenPrice: params.outputTokenPrice ?? 200,
        cacheReadTokenPrice: params.cacheReadTokenPrice ?? 0,
        cacheCreationTokenPrice: params.cacheCreationTokenPrice ?? 0,
      },
    });
}

async function insertRunBoundCreditUsage(params: {
  orgId: string;
  userId: string;
  model?: string;
  modelProvider?: string;
  resultUuid?: string | null;
  messageId?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  creditsCharged?: number | null;
  status?: string;
  processedAt?: Date | null;
}): Promise<string> {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: needs services initialised for direct DB setup
  initServices();
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: raw FK dependency seeding
  const [compose] = await globalThis.services.db
    .insert(agentComposes)
    .values({
      userId: params.userId,
      orgId: params.orgId,
      name: `compose-${randomUUID().slice(0, 8)}`,
    })
    .returning({ id: agentComposes.id });

  const versionId = createHash("sha256").update(randomUUID()).digest("hex");
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: raw FK dependency seeding
  await globalThis.services.db.insert(agentComposeVersions).values({
    id: versionId,
    composeId: compose!.id,
    content: {},
    createdBy: params.userId,
  });

  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: raw FK dependency seeding
  const [session] = await globalThis.services.db
    .insert(agentSessions)
    .values({
      userId: params.userId,
      orgId: params.orgId,
      agentComposeId: compose!.id,
    })
    .returning({ id: agentSessions.id });

  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: raw FK dependency seeding
  const [run] = await globalThis.services.db
    .insert(agentRuns)
    .values({
      userId: params.userId,
      orgId: params.orgId,
      agentComposeVersionId: versionId,
      sessionId: session!.id,
      prompt: "test",
      status: "completed",
    })
    .returning({ id: agentRuns.id });

  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: seeds legacy source row
  const [row] = await globalThis.services.db
    .insert(creditUsage)
    .values({
      runId: run!.id,
      resultUuid: params.resultUuid ?? null,
      messageId: params.messageId ?? null,
      orgId: params.orgId,
      userId: params.userId,
      model: params.model ?? `model-${randomUUID()}`,
      modelProvider: params.modelProvider ?? "",
      inputTokens: params.inputTokens ?? 0,
      outputTokens: params.outputTokens ?? 0,
      cacheReadInputTokens: params.cacheReadInputTokens ?? 0,
      cacheCreationInputTokens: params.cacheCreationInputTokens ?? 0,
      webSearchRequests: 0,
      status: params.status ?? "processed",
      creditsCharged: params.creditsCharged ?? null,
      processedAt:
        params.processedAt === undefined
          ? new Date("2026-01-02T03:04:05.000Z")
          : params.processedAt,
    })
    .returning({ id: creditUsage.id });

  return row!.id;
}

async function insertLegacyCreditUsage(params: {
  orgId: string;
  userId: string;
  model?: string;
  modelProvider?: string;
  resultUuid?: string | null;
  messageId?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  creditsCharged?: number | null;
  status?: string;
  processedAt?: Date | null;
}) {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: needs services initialised for direct DB setup
  initServices();
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: seeds legacy source row
  const [row] = await globalThis.services.db
    .insert(creditUsage)
    .values({
      runId: null,
      resultUuid: params.resultUuid ?? null,
      messageId: params.messageId ?? null,
      orgId: params.orgId,
      userId: params.userId,
      model: params.model ?? `model-${randomUUID()}`,
      modelProvider: params.modelProvider ?? "",
      inputTokens: params.inputTokens ?? 0,
      outputTokens: params.outputTokens ?? 0,
      cacheReadInputTokens: params.cacheReadInputTokens ?? 0,
      cacheCreationInputTokens: params.cacheCreationInputTokens ?? 0,
      webSearchRequests: 0,
      status: params.status ?? "processed",
      creditsCharged: params.creditsCharged ?? null,
      processedAt:
        params.processedAt === undefined
          ? new Date("2026-01-02T03:04:05.000Z")
          : params.processedAt,
    })
    .returning({
      id: creditUsage.id,
      resultUuid: creditUsage.resultUuid,
      createdAt: creditUsage.createdAt,
      processedAt: creditUsage.processedAt,
    });
  return row!;
}

async function readCreditUsageSource(id: string) {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: needs services initialised for direct DB assertion
  initServices();
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: read-back assertion
  const [row] = await globalThis.services.db
    .select({
      id: creditUsage.id,
      runId: creditUsage.runId,
      createdAt: creditUsage.createdAt,
      processedAt: creditUsage.processedAt,
    })
    .from(creditUsage)
    .where(eq(creditUsage.id, id))
    .limit(1);
  return row!;
}

async function findUsageEventsForOrg(orgId: string) {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: needs services initialised for direct DB assertion
  initServices();
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: read-back assertion
  return globalThis.services.db
    .select({
      idempotencyKey: usageEvent.idempotencyKey,
      runId: usageEvent.runId,
      orgId: usageEvent.orgId,
      userId: usageEvent.userId,
      kind: usageEvent.kind,
      provider: usageEvent.provider,
      category: usageEvent.category,
      quantity: usageEvent.quantity,
      creditsCharged: usageEvent.creditsCharged,
      status: usageEvent.status,
      billingError: usageEvent.billingError,
      createdAt: usageEvent.createdAt,
      processedAt: usageEvent.processedAt,
    })
    .from(usageEvent)
    .where(eq(usageEvent.orgId, orgId))
    .orderBy(usageEvent.category);
}

async function corruptUsageEventQuantity(params: {
  orgId: string;
  category: string;
}): Promise<void> {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: needs services initialised for direct DB setup
  initServices();
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: corrupts target row to exercise conflict guard
  await globalThis.services.db
    .update(usageEvent)
    .set({ quantity: 999 })
    .where(
      and(
        eq(usageEvent.orgId, params.orgId),
        eq(usageEvent.category, params.category),
      ),
    );
}

async function deleteBackfillRowsForOrg(orgId: string): Promise<void> {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: needs services initialised for direct DB cleanup
  initServices();
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: cleanup invalid fixture rows
  await globalThis.services.db
    .delete(usageEvent)
    .where(eq(usageEvent.orgId, orgId));
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration test: cleanup invalid fixture rows
  await globalThis.services.db
    .delete(creditUsage)
    .where(eq(creditUsage.orgId, orgId));
}

describe("migration 0329 backfill credit_usage to usage_event", () => {
  it("keeps the producer UUIDv5 name encoding compatible", () => {
    expect(
      expectedIdempotencyKey(["run-123", "msg-456", "tokens.input"]),
    ).toBe("1f58e71b-bb06-5114-984c-64021c8a5626");
  });

  it("backfills all orgs when the org-id test override is unset", async () => {
    await withCleanCreditUsageTransaction(async (tx) => {
      const suffix = randomUUID().slice(0, 8);
      const orgA = `unset-org-a-${suffix}`;
      const orgB = `unset-org-b-${suffix}`;
      const setting = await tx<{ value: string | null }[]>`
        SELECT current_setting('vm0.credit_usage_backfill_org_id', true) AS value
      `;
      expect(setting[0]?.value).toBeNull();

      await tx`
        INSERT INTO credit_usage (
          id,
          run_id,
          result_uuid,
          message_id,
          org_id,
          user_id,
          model,
          model_provider,
          input_tokens,
          output_tokens,
          cache_read_input_tokens,
          cache_creation_input_tokens,
          web_search_requests,
          status,
          credits_charged,
          processed_at
        )
        VALUES
          (
            ${randomUUID()}::uuid,
            NULL,
            NULL,
            NULL,
            ${orgA},
            ${`user-a-${suffix}`},
            ${`unset-model-a-${suffix}`},
            '',
            2,
            0,
            0,
            0,
            0,
            'processed',
            2,
            '2026-01-02T03:04:05.000Z'::timestamp
          ),
          (
            ${randomUUID()}::uuid,
            NULL,
            NULL,
            NULL,
            ${orgB},
            ${`user-b-${suffix}`},
            ${`unset-model-b-${suffix}`},
            '',
            0,
            3,
            0,
            0,
            0,
            'processed',
            5,
            '2026-01-02T03:04:05.000Z'::timestamp
          )
      `;

      await runMigrationStatements(tx);

      const rows = await tx<
        {
          orgId: string;
          category: string;
          quantity: number;
          creditsCharged: number;
        }[]
      >`
        SELECT
          org_id AS "orgId",
          category,
          quantity::int AS quantity,
          credits_charged::int AS "creditsCharged"
        FROM usage_event
        WHERE org_id IN (${orgA}, ${orgB})
        ORDER BY org_id, category
      `;
      expect(rows).toEqual([
        {
          orgId: orgA,
          category: "tokens.input",
          quantity: 2,
          creditsCharged: 2,
        },
        {
          orgId: orgB,
          category: "tokens.output",
          quantity: 3,
          creditsCharged: 5,
        },
      ]);
    });
  });

  it("treats an empty org-id test override as unset", async () => {
    await withCleanCreditUsageTransaction(async (tx) => {
      const suffix = randomUUID().slice(0, 8);
      const orgId = `empty-org-${suffix}`;
      await tx`
        INSERT INTO credit_usage (
          id,
          run_id,
          result_uuid,
          message_id,
          org_id,
          user_id,
          model,
          model_provider,
          input_tokens,
          output_tokens,
          cache_read_input_tokens,
          cache_creation_input_tokens,
          web_search_requests,
          status,
          credits_charged,
          processed_at
        )
        VALUES (
          ${randomUUID()}::uuid,
          NULL,
          NULL,
          NULL,
          ${orgId},
          ${`user-${suffix}`},
          ${`empty-model-${suffix}`},
          '',
          0,
          0,
          4,
          0,
          0,
          'processed',
          6,
          '2026-01-02T03:04:05.000Z'::timestamp
        )
      `;

      await tx`SELECT set_config('vm0.credit_usage_backfill_org_id', '', true)`;
      await runMigrationStatements(tx);

      const rows = await tx<
        {
          orgId: string;
          category: string;
          quantity: number;
          creditsCharged: number;
        }[]
      >`
        SELECT
          org_id AS "orgId",
          category,
          quantity::int AS quantity,
          credits_charged::int AS "creditsCharged"
        FROM usage_event
        WHERE org_id = ${orgId}
        ORDER BY org_id, category
      `;
      expect(rows).toEqual([
        {
          orgId,
          category: "tokens.cache_read",
          quantity: 4,
          creditsCharged: 6,
        },
      ]);
    });
  });

  it("backfills processed model rows with producer-compatible idempotency keys and matching pricing splits", async () => {
    const user = testIdentity();
    const model = `model-${randomUUID()}`;
    await insertCreditPricing({
      model,
      modelProvider: "anthropic",
      inputTokenPrice: 1_000_000,
      outputTokenPrice: 2_000_000,
    });
    const sourceId = await insertRunBoundCreditUsage({
      orgId: user.orgId,
      userId: user.userId,
      model,
      modelProvider: "anthropic",
      messageId: "msg-1",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      status: "processed",
      creditsCharged: 20,
      processedAt: new Date("2026-01-02T03:04:05.000Z"),
    });
    const source = await readCreditUsageSource(sourceId);

    await runMigrationForOrg(user.orgId);
    await runMigrationForOrg(user.orgId);

    const rows = await findUsageEventsForOrg(user.orgId);
    expect(rows).toHaveLength(2);
    expect(rows).toMatchObject([
      {
        idempotencyKey: expectedIdempotencyKey([
          source.runId!,
          "msg-1",
          "tokens.input",
        ]),
        runId: source.runId,
        orgId: user.orgId,
        userId: user.userId,
        kind: "model",
        provider: model,
        category: "tokens.input",
        quantity: 10,
        creditsCharged: 10,
        status: "processed",
        billingError: null,
      },
      {
        idempotencyKey: expectedIdempotencyKey([
          source.runId!,
          "msg-1",
          "tokens.output",
        ]),
        runId: source.runId,
        orgId: user.orgId,
        userId: user.userId,
        kind: "model",
        provider: model,
        category: "tokens.output",
        quantity: 5,
        creditsCharged: 10,
        status: "processed",
        billingError: null,
      },
    ]);
    expect(
      rows.map((row) => {
        return row.createdAt.toISOString();
      }),
    ).toEqual([
      source.createdAt.toISOString(),
      source.createdAt.toISOString(),
    ]);
    expect(
      rows.map((row) => {
        return row.processedAt?.toISOString();
      }),
    ).toEqual([
      source.processedAt?.toISOString(),
      source.processedAt?.toISOString(),
    ]);
  });

  it("backfills all token categories when pricing exactly preserves the source total", async () => {
    const user = testIdentity();
    const model = `all-categories-${randomUUID()}`;
    await insertCreditPricing({
      model,
      modelProvider: "anthropic",
      inputTokenPrice: 1_000_000,
      outputTokenPrice: 2_000_000,
      cacheReadTokenPrice: 3_000_000,
      cacheCreationTokenPrice: 4_000_000,
    });
    await insertRunBoundCreditUsage({
      orgId: user.orgId,
      userId: user.userId,
      model,
      modelProvider: "anthropic",
      messageId: "msg-all-categories",
      inputTokens: 1,
      outputTokens: 2,
      cacheReadInputTokens: 3,
      cacheCreationInputTokens: 4,
      status: "processed",
      creditsCharged: 30,
    });

    await runMigrationForOrg(user.orgId);

    const rowsByCategory = new Map(
      (await findUsageEventsForOrg(user.orgId)).map((row) => {
        return [row.category, row] as const;
      }),
    );
    expect(rowsByCategory.size).toBe(4);
    expect(rowsByCategory.get("tokens.cache_creation")).toMatchObject({
      quantity: 4,
      creditsCharged: 16,
    });
    expect(rowsByCategory.get("tokens.cache_read")).toMatchObject({
      quantity: 3,
      creditsCharged: 9,
    });
    expect(rowsByCategory.get("tokens.input")).toMatchObject({
      quantity: 1,
      creditsCharged: 1,
    });
    expect(rowsByCategory.get("tokens.output")).toMatchObject({
      quantity: 2,
      creditsCharged: 4,
    });
  });

  it("uses backfill-specific idempotency keys for runless rows and preserves null credits", async () => {
    const user = testIdentity();
    const resultUuid = randomUUID();
    const source = await insertLegacyCreditUsage({
      orgId: user.orgId,
      userId: user.userId,
      resultUuid,
      inputTokens: 4,
      cacheReadInputTokens: 6,
      creditsCharged: null,
    });

    await runMigrationForOrg(user.orgId);

    const rows = await findUsageEventsForOrg(user.orgId);
    expect(rows).toHaveLength(2);
    expect(rows).toMatchObject([
      {
        idempotencyKey: expectedIdempotencyKey([
          "credit-usage-backfill:v1",
          source.id,
          "<null-run-id>",
          "<null-message-id>",
          resultUuid,
          "tokens.cache_read",
        ]),
        runId: null,
        category: "tokens.cache_read",
        quantity: 6,
        creditsCharged: null,
      },
      {
        idempotencyKey: expectedIdempotencyKey([
          "credit-usage-backfill:v1",
          source.id,
          "<null-run-id>",
          "<null-message-id>",
          resultUuid,
          "tokens.input",
        ]),
        runId: null,
        category: "tokens.input",
        quantity: 4,
        creditsCharged: null,
      },
    ]);
  });

  it("uses backfill-specific idempotency keys for run-bound rows without message IDs", async () => {
    const user = testIdentity();
    const resultUuid = randomUUID();
    const sourceId = await insertRunBoundCreditUsage({
      orgId: user.orgId,
      userId: user.userId,
      resultUuid,
      messageId: null,
      inputTokens: 9,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      status: "processed",
      creditsCharged: 3,
    });
    const source = await readCreditUsageSource(sourceId);

    await runMigrationForOrg(user.orgId);

    expect(await findUsageEventsForOrg(user.orgId)).toMatchObject([
      {
        idempotencyKey: expectedIdempotencyKey([
          "credit-usage-backfill:v1",
          source.id,
          source.runId!,
          "<null-message-id>",
          resultUuid,
          "tokens.input",
        ]),
        runId: source.runId,
        category: "tokens.input",
        quantity: 9,
        creditsCharged: 3,
      },
    ]);
  });

  it("falls back to deterministic token-quantity credit allocation when pricing is unavailable", async () => {
    const user = testIdentity();
    await insertRunBoundCreditUsage({
      orgId: user.orgId,
      userId: user.userId,
      model: `unpriced-${randomUUID()}`,
      messageId: "msg-alloc",
      inputTokens: 10,
      outputTokens: 30,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      status: "processed",
      creditsCharged: 7,
    });

    await runMigrationForOrg(user.orgId);

    expect(
      (await findUsageEventsForOrg(user.orgId)).map((row) => {
        return {
          category: row.category,
          creditsCharged: row.creditsCharged,
        };
      }),
    ).toEqual([
      { category: "tokens.input", creditsCharged: 2 },
      { category: "tokens.output", creditsCharged: 5 },
    ]);
  });

  it("falls back to token-quantity allocation when complete pricing does not match source credits", async () => {
    const user = testIdentity();
    const model = `mismatched-pricing-${randomUUID()}`;
    await insertCreditPricing({
      model,
      inputTokenPrice: 1_000_000,
      outputTokenPrice: 1_000_000,
    });
    await insertRunBoundCreditUsage({
      orgId: user.orgId,
      userId: user.userId,
      model,
      messageId: "msg-mismatched-pricing",
      inputTokens: 10,
      outputTokens: 30,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      status: "processed",
      creditsCharged: 7,
    });

    await runMigrationForOrg(user.orgId);

    expect(
      (await findUsageEventsForOrg(user.orgId)).map((row) => {
        return {
          category: row.category,
          creditsCharged: row.creditsCharged,
        };
      }),
    ).toEqual([
      { category: "tokens.input", creditsCharged: 2 },
      { category: "tokens.output", creditsCharged: 5 },
    ]);
  });

  it("uses category order to break equal fallback allocation remainders", async () => {
    const user = testIdentity();
    await insertRunBoundCreditUsage({
      orgId: user.orgId,
      userId: user.userId,
      model: `tie-allocation-${randomUUID()}`,
      messageId: "msg-tie-allocation",
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      status: "processed",
      creditsCharged: 1,
    });

    await runMigrationForOrg(user.orgId);

    expect(
      (await findUsageEventsForOrg(user.orgId)).map((row) => {
        return {
          category: row.category,
          creditsCharged: row.creditsCharged,
        };
      }),
    ).toEqual([
      { category: "tokens.input", creditsCharged: 1 },
      { category: "tokens.output", creditsCharged: 0 },
    ]);
  });

  it("assigns all source credits to the only positive token category", async () => {
    const user = testIdentity();
    await insertRunBoundCreditUsage({
      orgId: user.orgId,
      userId: user.userId,
      model: `single-category-${randomUUID()}`,
      messageId: "msg-single-category",
      inputTokens: 0,
      outputTokens: 3,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      status: "processed",
      creditsCharged: 11,
    });

    await runMigrationForOrg(user.orgId);

    expect(
      (await findUsageEventsForOrg(user.orgId)).map((row) => {
        return {
          category: row.category,
          quantity: row.quantity,
          creditsCharged: row.creditsCharged,
        };
      }),
    ).toEqual([
      { category: "tokens.output", quantity: 3, creditsCharged: 11 },
    ]);
  });

  it("skips rows that are not processed with positive tokens and processed_at", async () => {
    const user = testIdentity();
    await insertLegacyCreditUsage({
      orgId: user.orgId,
      userId: user.userId,
      inputTokens: 0,
      outputTokens: 0,
      status: "processed",
      creditsCharged: 0,
    });
    await insertLegacyCreditUsage({
      orgId: user.orgId,
      userId: user.userId,
      inputTokens: 1,
      status: "pending",
      creditsCharged: null,
      processedAt: null,
    });
    await insertLegacyCreditUsage({
      orgId: user.orgId,
      userId: user.userId,
      inputTokens: 1,
      status: "processed",
      creditsCharged: 1,
      processedAt: null,
    });

    await runMigrationForOrg(user.orgId);

    expect(await findUsageEventsForOrg(user.orgId)).toEqual([]);
  });

  it("rejects invalid source values before inserting", async () => {
    const user = testIdentity();
    try {
      await insertLegacyCreditUsage({
        orgId: user.orgId,
        userId: user.userId,
        inputTokens: -1,
        outputTokens: 1,
        creditsCharged: 1,
      });

      await expect(runMigrationForOrg(user.orgId)).rejects.toThrow(
        /negative token quantities/,
      );
      expect(await findUsageEventsForOrg(user.orgId)).toEqual([]);
    } finally {
      await deleteBackfillRowsForOrg(user.orgId);
    }
  });

  it("rejects negative source credits before inserting", async () => {
    const user = testIdentity();
    try {
      await insertLegacyCreditUsage({
        orgId: user.orgId,
        userId: user.userId,
        inputTokens: 1,
        creditsCharged: -1,
      });

      await expect(runMigrationForOrg(user.orgId)).rejects.toThrow(
        /negative credits_charged/,
      );
      expect(await findUsageEventsForOrg(user.orgId)).toEqual([]);
    } finally {
      await deleteBackfillRowsForOrg(user.orgId);
    }
  });

  it("rejects provider values that cannot fit usage_event", async () => {
    const user = testIdentity();
    try {
      await insertLegacyCreditUsage({
        orgId: user.orgId,
        userId: user.userId,
        model: "m".repeat(101),
        inputTokens: 1,
        creditsCharged: 1,
      });

      await expect(runMigrationForOrg(user.orgId)).rejects.toThrow(
        /model exceeds usage_event\.provider length/,
      );
      expect(await findUsageEventsForOrg(user.orgId)).toEqual([]);
    } finally {
      await deleteBackfillRowsForOrg(user.orgId);
    }
  });

  it("rejects existing idempotency-key rows whose payload differs", async () => {
    const user = testIdentity();
    try {
      await insertRunBoundCreditUsage({
        orgId: user.orgId,
        userId: user.userId,
        model: `conflict-${randomUUID()}`,
        messageId: "msg-conflict",
        inputTokens: 2,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        status: "processed",
        creditsCharged: 5,
      });
      await runMigrationForOrg(user.orgId);
      await corruptUsageEventQuantity({
        orgId: user.orgId,
        category: "tokens.input",
      });

      await expect(runMigrationForOrg(user.orgId)).rejects.toThrow(
        /existing usage_event rows with mismatched payloads/,
      );
    } finally {
      await deleteBackfillRowsForOrg(user.orgId);
    }
  });
});
