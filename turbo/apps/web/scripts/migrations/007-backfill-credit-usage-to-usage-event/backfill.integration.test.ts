import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { schema } from "@vm0/db";
// eslint-disable-next-line web/no-direct-db-in-tests -- Migration script integration test reads exact legacy source rows
import { creditUsage } from "@vm0/db/schema/credit-usage";
// eslint-disable-next-line web/no-direct-db-in-tests -- Migration script integration test verifies exact target rows
import { usageEvent } from "@vm0/db/schema/usage-event";
import {
  deriveUsageEventIdempotencyKey,
  runBackfillWithDb,
  type CliOptions,
  type CreditUsageSourceRow,
} from "./backfill";
import { testContext, uniqueId } from "../../../src/__tests__/test-helpers";
import {
  insertTestCreditPricing,
  insertTestCreditUsage,
} from "../../../src/__tests__/db-test-seeders/credits";

/**
 * Integration coverage for the manual credit_usage -> usage_event backfill
 * script. These tests execute the script entrypoint against the real test DB
 * so dry-run, migrate, conflict handling, and idempotency are exercised
 * together rather than only through pure mapping helpers.
 */

const context = testContext();

type BackfilledUsageEvent = {
  idempotencyKey: string;
  runId: string | null;
  orgId: string;
  userId: string;
  kind: string;
  provider: string;
  category: string;
  quantity: number;
  creditsCharged: number | null;
  status: string;
  processedAt: Date | null;
};

function testDb() {
  // eslint-disable-next-line web/no-direct-db-in-tests -- Migration integration test uses the real test DB for setup/assertions
  return globalThis.services.db;
}

async function withScriptDb<T>(
  fn: (db: PostgresJsDatabase<typeof schema>) => Promise<T>,
): Promise<T> {
  const databaseUrl = process.env.DATABASE_URL;
  expect(databaseUrl).toBeTruthy();

  const client = postgres(databaseUrl!, { max: 1 });
  const db = drizzle(client, { schema });
  try {
    return await fn(db);
  } finally {
    await client.end();
  }
}

function backfillOptions(orgId: string, migrate: boolean): CliOptions {
  return {
    migrate,
    batchSize: 50,
    orgId,
    failOnAnomaly: false,
  };
}

async function readSourceRow(id: string): Promise<CreditUsageSourceRow> {
  const [row] = await testDb()
    .select()
    .from(creditUsage)
    .where(eq(creditUsage.id, id))
    .limit(1);
  expect(row).toBeDefined();
  return row!;
}

async function readUsageEvents(orgId: string): Promise<BackfilledUsageEvent[]> {
  return await testDb()
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
      processedAt: usageEvent.processedAt,
    })
    .from(usageEvent)
    .where(eq(usageEvent.orgId, orgId))
    .orderBy(usageEvent.category);
}

async function seedProcessedCreditUsage(params: {
  orgId: string;
  userId: string;
  model: string;
  creditsCharged?: number | null;
}): Promise<CreditUsageSourceRow> {
  await insertTestCreditPricing(params.model, {
    modelProvider: "anthropic",
    inputTokenPrice: 1_000_000,
    outputTokenPrice: 1_000_000,
  });
  const id = await insertTestCreditUsage(params.orgId, {
    userId: params.userId,
    model: params.model,
    modelProvider: "anthropic",
    inputTokens: 1,
    outputTokens: 2,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    messageId: "message-1",
    status: "processed",
    ...(params.creditsCharged === null
      ? {}
      : { creditsCharged: params.creditsCharged }),
  });
  return await readSourceRow(id);
}

describe("credit_usage to usage_event backfill script", () => {
  beforeEach(() => {
    context.setupMocks();
  });

  it("dry-run plans rows without writing usage_event records", async () => {
    const user = await context.setupUser({ prefix: "backfill-dry" });
    const model = uniqueId("model-dry");
    await seedProcessedCreditUsage({
      orgId: user.orgId,
      userId: user.userId,
      model,
      creditsCharged: 3,
    });

    const stats = await withScriptDb((db) => {
      return runBackfillWithDb(db, backfillOptions(user.orgId, false));
    });

    expect(stats.plannedSourceRows).toBe(1);
    expect(stats.plannedUsageEvents).toBe(2);
    expect(stats.insertedUsageEvents).toBe(0);
    expect(await readUsageEvents(user.orgId)).toHaveLength(0);
  }, 20_000);

  it("migrates processed rows and is idempotent on rerun", async () => {
    const user = await context.setupUser({ prefix: "backfill-migrate" });
    const model = uniqueId("model-migrate");
    const source = await seedProcessedCreditUsage({
      orgId: user.orgId,
      userId: user.userId,
      model,
      creditsCharged: 3,
    });

    const first = await withScriptDb((db) => {
      return runBackfillWithDb(db, backfillOptions(user.orgId, true));
    });
    expect(first.plannedUsageEvents).toBe(2);
    expect(first.insertedUsageEvents).toBe(2);

    const events = await readUsageEvents(user.orgId);
    expect(events).toEqual([
      {
        idempotencyKey: deriveUsageEventIdempotencyKey(source, "tokens.input"),
        runId: source.runId,
        orgId: user.orgId,
        userId: user.userId,
        kind: "model",
        provider: model,
        category: "tokens.input",
        quantity: 1,
        creditsCharged: 1,
        status: "processed",
        processedAt: source.processedAt,
      },
      {
        idempotencyKey: deriveUsageEventIdempotencyKey(source, "tokens.output"),
        runId: source.runId,
        orgId: user.orgId,
        userId: user.userId,
        kind: "model",
        provider: model,
        category: "tokens.output",
        quantity: 2,
        creditsCharged: 2,
        status: "processed",
        processedAt: source.processedAt,
      },
    ]);

    const second = await withScriptDb((db) => {
      return runBackfillWithDb(db, backfillOptions(user.orgId, true));
    });
    expect(second.existingUsageEvents).toBe(2);
    expect(second.insertedUsageEvents).toBe(0);
    expect(await readUsageEvents(user.orgId)).toHaveLength(2);
  }, 20_000);

  it("preserves NULL credits through a migrate run", async () => {
    const user = await context.setupUser({ prefix: "backfill-null" });
    const model = uniqueId("model-null");
    await seedProcessedCreditUsage({
      orgId: user.orgId,
      userId: user.userId,
      model,
      creditsCharged: null,
    });

    const stats = await withScriptDb((db) => {
      return runBackfillWithDb(db, backfillOptions(user.orgId, true));
    });
    expect(stats.nullCreditsRows).toBe(1);
    expect(stats.insertedUsageEvents).toBe(2);

    const events = await readUsageEvents(user.orgId);
    expect(
      events.map((event) => {
        return event.creditsCharged;
      }),
    ).toEqual([null, null]);
  }, 20_000);
});
