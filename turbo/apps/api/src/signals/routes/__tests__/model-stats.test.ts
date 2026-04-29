import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { creditUsage } from "@vm0/db/schema/credit-usage";
import { modelStat } from "@vm0/db/schema/model-stat";
import { usageEvent } from "@vm0/db/schema/usage-event";

import { mockEnv } from "../../../lib/env";
import { mockNow } from "../../../lib/time";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import { modelStatsContract } from "../model-stats";

const store = createStore();
const context = testContext();

function client() {
  return setupApp({ context })(modelStatsContract);
}

describe("GET /api/internal/cron/aggregate-model-stats", () => {
  beforeEach(() => {
    mockEnv("CRON_SECRET", "test-cron-secret");
    mockNow(new Date("2026-04-29T15:30:00.000Z"));
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

  it("aggregates hourly model usage and excludes connector usage", async () => {
    const db = store.set(writeDb$);
    const model = `test-model-${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const connectorProvider = `x-${randomUUID()}`;
    const createdAt = new Date("2026-04-29T14:10:00.000Z");
    const connectorEventId = randomUUID();
    const outputEventId = randomUUID();

    await db.insert(creditUsage).values({
      orgId,
      userId,
      model,
      modelProvider: "",
      inputTokens: 100,
      outputTokens: 40,
      cacheReadInputTokens: 10,
      cacheCreationInputTokens: 5,
      creditsCharged: 12,
      status: "processed",
      createdAt,
      processedAt: createdAt,
    });

    await db.insert(usageEvent).values([
      {
        idempotencyKey: randomUUID(),
        orgId,
        userId,
        kind: "model",
        provider: model,
        category: "tokens.input",
        quantity: 300,
        creditsCharged: 3,
        status: "processed",
        createdAt,
        processedAt: createdAt,
      },
      {
        idempotencyKey: outputEventId,
        orgId,
        userId,
        kind: "model",
        provider: model,
        category: "tokens.output",
        quantity: 200,
        creditsCharged: 4,
        status: "processed",
        createdAt,
        processedAt: createdAt,
      },
      {
        idempotencyKey: connectorEventId,
        orgId,
        userId,
        kind: "connector",
        provider: connectorProvider,
        category: "tweet.read",
        quantity: 999_999,
        creditsCharged: 999,
        status: "processed",
        createdAt,
        processedAt: createdAt,
      },
    ]);

    const response = await accept(
      client().aggregate({
        headers: { authorization: "Bearer test-cron-secret" },
      }),
      [200],
    );

    expect(response.body.windowStart).toBe("2026-04-28T15:00:00.000Z");
    expect(response.body.windowEnd).toBe("2026-04-29T15:00:00.000Z");

    const [row] = await db
      .select()
      .from(modelStat)
      .where(eq(modelStat.model, model))
      .limit(1);

    expect(row).toMatchObject({
      hourStart: new Date("2026-04-29T14:00:00.000Z"),
      inputTokens: 400,
      outputTokens: 240,
      cacheReadInputTokens: 10,
      cacheCreationInputTokens: 5,
      totalTokens: 655,
      creditsCharged: 19,
      requestCount: 3,
      orgCount: 1,
      userCount: 1,
    });

    await db
      .update(usageEvent)
      .set({ creditsCharged: 8 })
      .where(
        and(
          eq(usageEvent.idempotencyKey, outputEventId),
          eq(usageEvent.kind, "model"),
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
      .where(eq(modelStat.model, model))
      .limit(1);

    expect(updatedRow?.creditsCharged).toBe(23);

    const [connectorRow] = await db
      .select()
      .from(modelStat)
      .where(eq(modelStat.model, connectorProvider))
      .limit(1);

    expect(connectorRow).toBeUndefined();
  });
});
