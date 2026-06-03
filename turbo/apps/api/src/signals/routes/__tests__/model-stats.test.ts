import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { modelStat } from "@vm0/db/schema/model-stat";
import { modelUsageObservation } from "@vm0/db/schema/model-usage-observation";

import { mockEnv } from "../../../lib/env";
import { mockNow } from "../../../lib/time";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import { modelStatsContract } from "../model-stats";

const store = createStore();
const context = testContext();
const HOUR_MS = 60 * 60_000;

function client() {
  return setupApp({ context })(modelStatsContract);
}

describe("GET /api/internal/cron/aggregate-model-stats", () => {
  beforeEach(() => {
    mockEnv("CRON_SECRET", "test-cron-secret");
    mockNow(new Date("2099-01-01T15:30:00.000Z"));
  });

  it("requires the cron secret", async () => {
    const response = await accept(
      client().aggregate({
        headers: { authorization: "Bearer wrong" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Invalid cron secret", code: "UNAUTHORIZED" },
    });
  });

  it("aggregates hourly model usage observations by canonical model", async () => {
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

    const response = await accept(
      client().aggregate({
        headers: { authorization: "Bearer test-cron-secret" },
      }),
      [200],
    );

    expect(response.body.windowStart).toBe(expectedWindowStart.toISOString());
    expect(response.body.windowEnd).toBe(expectedWindowEnd.toISOString());
    await expect(
      db
        .select({ idempotencyKey: modelUsageObservation.idempotencyKey })
        .from(modelUsageObservation)
        .where(eq(modelUsageObservation.idempotencyKey, expiredObservationId)),
    ).resolves.toStrictEqual([]);
    await expect(
      db
        .select({ idempotencyKey: modelUsageObservation.idempotencyKey })
        .from(modelUsageObservation)
        .where(eq(modelUsageObservation.idempotencyKey, retainedObservationId)),
    ).resolves.toStrictEqual([{ idempotencyKey: retainedObservationId }]);

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

    await db
      .update(modelUsageObservation)
      .set({ quantity: 250 })
      .where(
        and(
          eq(modelUsageObservation.idempotencyKey, outputEventId),
          eq(modelUsageObservation.model, model),
        ),
      );

    await accept(
      client().aggregate({
        headers: { authorization: "Bearer test-cron-secret" },
      }),
      [200],
    );

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

describe("GET /api/public/model-rankings", () => {
  it("returns canonicalized public rankings without auth", async () => {
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
  });

  it("defaults unsupported periods to week", async () => {
    mockNow(new Date("2300-01-08T15:30:00.000Z"));

    const response = await accept(
      client().rankings({ query: { period: "unsupported" } }),
      [200],
    );

    expect(response.body.period).toBe("week");
  });
});
