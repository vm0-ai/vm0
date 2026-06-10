import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { modelStat } from "@vm0/db/schema/model-stat";
import { modelUsageObservation } from "@vm0/db/schema/model-usage-observation";
import { afterEach } from "vitest";

import { mockEnv } from "../../../lib/env";
import { mockNow } from "../../../lib/time";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import { modelStatsContract } from "../model-stats";

// BDD migration of the legacy `model-stats.test.ts`. The 4
// legacy `it()`s collapse into 2 BDD `it()`s: (1) cron
// aggregate chain (401 wrong secret → 200 aggregates hourly
// model usage observations by canonical model with full DB
// read-after-write verification, including idempotent
// re-aggregation + expiry of old observations), (2)
// public rankings chain (200 returns canonicalized public
// rankings without auth with cache-control header → 200
// defaults unsupported periods to week).
//
// Service-Level Exception: `modelUsageObservation` and
// `modelStat` rows are inserted and read directly via
// `writeDb$` because no public route creates them. The
// legacy test does not clean up these tables; the BDD
// migration adds an `afterEach` that wipes all rows to
// avoid stale data from prior runs.

const store = createStore();
const context = testContext();
const HOUR_MS = 60 * 60_000;

function client() {
  return setupApp({ context })(modelStatsContract);
}

afterEach(async () => {
  const db = store.set(writeDb$);
  await db.delete(modelStat);
  await db.delete(modelUsageObservation);
});

describe("BDD GET /api/internal/cron/aggregate-model-stats — auth + 200 success chain", () => {
  beforeEach(() => {
    mockEnv("CRON_SECRET", "test-cron-secret");
    mockNow(new Date("2099-01-01T15:30:00.000Z"));
  });

  it("gwt-wt-wt: 401 wrong secret → 200 aggregates hourly model usage observations by canonical model with full DB read-after-write verification", async () => {
    // When + Then: 401 — invalid cron secret.
    const wrongSecret = await accept(
      client().aggregate({
        headers: { authorization: "Bearer wrong" },
      }),
      [401],
    );
    expect(wrongSecret.body).toStrictEqual({
      error: { message: "Invalid cron secret", code: "UNAUTHORIZED" },
    });

    // Given: a 24-hour window of model usage observations
    // including a non-canonical model alias, an unknown
    // model, a zero-quantity row, an expired observation
    // (>33 days old), and a retained observation (within the
    // 31-day retention window).
    const db = store.set(writeDb$);
    const model = "claude-sonnet-4-6";
    const modelAlias = "anthropic/claude-sonnet-4.6";
    const unknownModel = `unknown-model-${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const connectorProvider = `x-${randomUUID()}`;
    const hourSeed = Number.parseInt(randomUUID().slice(0, 8), 16);
    const expectedHourStart = new Date(
      Date.UTC(2001, 0, 1) + (hourSeed % (24 * 365)) * HOUR_MS,
    );
    const expectedWindowEnd = new Date(expectedHourStart.getTime() + HOUR_MS);
    const expectedWindowStart = new Date(
      expectedWindowEnd.getTime() - 24 * HOUR_MS,
    );
    const createdAt = new Date(expectedHourStart.getTime() + 10 * 60_000);
    mockNow(new Date(expectedWindowEnd.getTime() + 30 * 60_000));
    const outputEventId = randomUUID();
    const expiredObservationId = randomUUID();
    const retainedObservationId = randomUUID();
    const expiredObservedAt = new Date(
      expectedWindowEnd.getTime() - 33 * 24 * HOUR_MS,
    );
    const retainedObservedAt = new Date(
      expectedWindowEnd.getTime() - 31 * 24 * HOUR_MS,
    );

    await db.insert(modelUsageObservation).values([
      {
        idempotencyKey: randomUUID(),
        orgId,
        userId,
        model,
        modelProviderType: "vm0",
        category: "tokens.input",
        quantity: 300,
        observedAt: createdAt,
      },
      {
        idempotencyKey: outputEventId,
        orgId,
        userId,
        model,
        modelProviderType: "anthropic-api-key",
        category: "tokens.output",
        quantity: 200,
        observedAt: createdAt,
      },
      {
        idempotencyKey: randomUUID(),
        orgId,
        userId,
        model: modelAlias,
        modelProviderType: "openrouter-api-key",
        category: "tokens.input",
        quantity: 25,
        observedAt: createdAt,
      },
      {
        idempotencyKey: randomUUID(),
        orgId,
        userId,
        model,
        modelProviderType: "vm0",
        category: "tokens.total",
        quantity: 1000,
        observedAt: createdAt,
      },
      {
        idempotencyKey: randomUUID(),
        orgId,
        userId,
        model,
        modelProviderType: "vm0",
        category: "tokens.input",
        quantity: 0,
        observedAt: createdAt,
      },
      {
        idempotencyKey: randomUUID(),
        orgId,
        userId,
        model: unknownModel,
        modelProviderType: "custom",
        category: "tokens.input",
        quantity: 300_000,
        observedAt: createdAt,
      },
      {
        idempotencyKey: expiredObservationId,
        orgId,
        userId,
        model,
        modelProviderType: "vm0",
        category: "tokens.input",
        quantity: 1,
        observedAt: expiredObservedAt,
      },
      {
        idempotencyKey: retainedObservationId,
        orgId,
        userId,
        model,
        modelProviderType: "vm0",
        category: "tokens.input",
        quantity: 1,
        observedAt: retainedObservedAt,
      },
    ]);

    // When: aggregate.
    const response = await accept(
      client().aggregate({
        headers: { authorization: "Bearer test-cron-secret" },
      }),
      [200],
    );

    // Then: 200 + the window matches the expected 24-hour
    // window + the expired observation is purged + the
    // retained one is kept.
    expect(response.body.windowStart).toBe(expectedWindowStart.toISOString());
    expect(response.body.windowEnd).toBe(expectedWindowEnd.toISOString());
    await expect(
      db
        .select({ idempotencyKey: modelUsageObservation.idempotencyKey })
        .from(modelUsageObservation)
        .where(
          eq(modelUsageObservation.idempotencyKey, expiredObservationId),
        ),
    ).resolves.toStrictEqual([]);
    await expect(
      db
        .select({ idempotencyKey: modelUsageObservation.idempotencyKey })
        .from(modelUsageObservation)
        .where(
          eq(modelUsageObservation.idempotencyKey, retainedObservationId),
        ),
    ).resolves.toStrictEqual([{ idempotencyKey: retainedObservationId }]);

    // Then: the canonical-model row aggregates the input +
    // output tokens across all observations in the hour.
    const [row] = await db
      .select()
      .from(modelStat)
      .where(
        and(
          eq(modelStat.model, model),
          eq(modelStat.hourStart, expectedHourStart),
        ),
      )
      .limit(1);
    expect(row).toMatchObject({
      hourStart: expectedHourStart,
      modelProvider: "",
      inputTokens: 325,
      outputTokens: 200,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      totalTokens: 525,
      creditsCharged: 0,
      requestCount: 3,
      orgCount: 1,
      userCount: 1,
    });

    // Given: the output observation is updated.
    await db
      .update(modelUsageObservation)
      .set({ quantity: 250 })
      .where(
        and(
          eq(modelUsageObservation.idempotencyKey, outputEventId),
          eq(modelUsageObservation.model, model),
        ),
      );

    // When: re-aggregate.
    await accept(
      client().aggregate({
        headers: { authorization: "Bearer test-cron-secret" },
      }),
      [200],
    );

    // Then: the canonical-model row reflects the updated
    // output quantity (idempotent re-aggregation).
    const [updatedRow] = await db
      .select()
      .from(modelStat)
      .where(
        and(
          eq(modelStat.model, model),
          eq(modelStat.hourStart, expectedHourStart),
        ),
      )
      .limit(1);
    expect(updatedRow?.outputTokens).toBe(250);
    expect(updatedRow?.totalTokens).toBe(575);

    // Then: no row is created for the connector provider or
    // the unknown model.
    const [connectorRow] = await db
      .select()
      .from(modelStat)
      .where(
        and(
          eq(modelStat.model, connectorProvider),
          eq(modelStat.hourStart, expectedHourStart),
        ),
      )
      .limit(1);
    expect(connectorRow).toBeUndefined();
    const [unknownModelRow] = await db
      .select()
      .from(modelStat)
      .where(
        and(
          eq(modelStat.model, unknownModel),
          eq(modelStat.hourStart, expectedHourStart),
        ),
      )
      .limit(1);
    expect(unknownModelRow).toBeUndefined();
  });
});

describe("BDD GET /api/public/model-rankings — 200 chain", () => {
  it("gwt-wt-wt: 200 returns canonicalized public rankings without auth with cache-control header → 200 defaults unsupported periods to week", async () => {
    // Given: a model + a model alias + an unsupported model
    // with hourStart rows in the current + previous hour.
    const db = store.set(writeDb$);
    const model = "claude-sonnet-4-6";
    const modelAlias = "anthropic/claude-sonnet-4.6";
    const unsupportedModel = `unsupported-model-${randomUUID()}`;
    const daySeed = Number.parseInt(randomUUID().slice(0, 8), 16);
    const windowStart = new Date(Date.UTC(2200, 0, 1 + (daySeed % 90), 0));
    const windowEnd = new Date(windowStart.getTime() + 12 * HOUR_MS);
    const currentHour = new Date(windowEnd.getTime() - HOUR_MS);
    const previousHour = new Date(windowStart.getTime() - HOUR_MS);
    mockNow(new Date(windowEnd.getTime() + 30 * 60_000));

    await db.insert(modelStat).values([
      {
        hourStart: currentHour,
        model: modelAlias,
        inputTokens: 100,
        outputTokens: 50,
        cacheReadInputTokens: 40,
        cacheCreationInputTokens: 10,
        totalTokens: 200,
      },
      {
        hourStart: previousHour,
        model,
        totalTokens: 80,
      },
      {
        hourStart: currentHour,
        model: unsupportedModel,
        inputTokens: 9999,
        totalTokens: 9999,
      },
    ]);

    // When + Then: 200 — public rankings return the
    // canonicalized model with the cache-control header.
    const response = await accept(
      client().rankings({ query: { period: "today" } }),
      [200],
    );
    expect(response.headers.get("cache-control")).toBe(
      "public, s-maxage=300, stale-while-revalidate=600",
    );
    expect(response.body).toStrictEqual({
      period: "today",
      totalTokens: 200,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      rows: [
        {
          model,
          inputTokens: 150,
          outputTokens: 50,
          totalTokens: 200,
          previousTotalTokens: 80,
        },
      ],
    });

    // Given: a future mock-now.
    mockNow(new Date("2300-01-08T15:30:00.000Z"));

    // When + Then: 200 — unsupported periods default to
    // `week`.
    const unsupportedPeriod = await accept(
      client().rankings({ query: { period: "unsupported" } }),
      [200],
    );
    expect(unsupportedPeriod.body.period).toBe("week");
  });
});
