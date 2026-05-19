import { randomUUID } from "node:crypto";

import { cronTelegramCleanupContract } from "@vm0/api-contracts/contracts/cron";
import { telegramMessages } from "@vm0/db/schema/telegram-message";
import { createStore } from "ccstate";
import { count, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { clearMockNow, mockNow, nowDate } from "../../../lib/time";
import { writeDb$ } from "../../external/db";
import {
  deleteTelegramFixture$,
  freezeTelegramFixture,
  makeTelegramFixtureBuilder,
  seedTelegramInstallation$,
  type TelegramFixture,
} from "./helpers/zero-telegram";
import { createFixtureTracker } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const FIXED_NOW_MS = Date.UTC(2026, 4, 14, 12, 0, 0);

function apiClient() {
  return setupApp({ context })(cronTelegramCleanupContract);
}

function cronHeaders(secret = "test-cron-secret") {
  return { authorization: `Bearer ${secret}` };
}

function newId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

async function cleanupFixture(fixture: TelegramFixture): Promise<void> {
  await store.set(deleteTelegramFixture$, fixture, context.signal);
}

async function seedInstallation(): Promise<TelegramFixture> {
  const orgId = newId("org");
  const userId = newId("user");
  const telegramBotId = newId("telegram-bot");
  const builder = makeTelegramFixtureBuilder(orgId);
  const installation = await store.set(
    seedTelegramInstallation$,
    {
      orgId,
      ownerUserId: userId,
      telegramBotId,
    },
    context.signal,
  );

  builder.composeIds.push(installation.composeId);
  builder.telegramBotIds.push(installation.telegramBotId);
  builder.userIds.push(userId);

  return freezeTelegramFixture(builder);
}

async function insertMessages(args: {
  readonly installationId: string;
  readonly messages: number;
  readonly createdAt: Date;
}): Promise<void> {
  const db = store.set(writeDb$);
  await db.insert(telegramMessages).values(
    Array.from({ length: args.messages }, () => {
      return {
        installationId: args.installationId,
        chatId: newId("chat"),
        messageId: newId("message"),
        fromUserId: newId("from-user"),
        text: "test message",
        createdAt: args.createdAt,
      };
    }),
  );
}

async function countMessages(installationId: string): Promise<number> {
  const db = store.set(writeDb$);
  const [row] = await db
    .select({ value: count() })
    .from(telegramMessages)
    .where(eq(telegramMessages.installationId, installationId));
  return row?.value ?? 0;
}

describe("GET /api/cron/telegram-cleanup", () => {
  const track = createFixtureTracker<TelegramFixture>(cleanupFixture);

  beforeEach(() => {
    mockEnv("CRON_SECRET", "test-cron-secret");
    mockNow(FIXED_NOW_MS);
  });

  afterEach(() => {
    clearMockNow();
  });

  it("rejects requests with an invalid cron secret", async () => {
    const response = await accept(
      apiClient().cleanup({ headers: cronHeaders("wrong-secret") }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Invalid cron secret", code: "UNAUTHORIZED" },
    });
  });

  it("rejects requests without cron authorization", async () => {
    const response = await accept(apiClient().cleanup({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: { message: "Invalid cron secret", code: "UNAUTHORIZED" },
    });
  });

  it("preserves recent messages and returns a deleted count", async () => {
    const fixture = await track(seedInstallation());
    const installationId = fixture.telegramBotIds[0] ?? "";
    await insertMessages({
      installationId,
      messages: 2,
      createdAt: nowDate(),
    });

    const response = await accept(
      apiClient().cleanup({ headers: cronHeaders() }),
      [200],
    );

    expect(typeof response.body.deleted).toBe("number");
    await expect(countMessages(installationId)).resolves.toBe(2);
  });

  it("deletes messages older than 30 days", async () => {
    const fixture = await track(seedInstallation());
    const installationId = fixture.telegramBotIds[0] ?? "";
    const oldDate = nowDate();
    oldDate.setDate(oldDate.getDate() - 31);
    const recentDate = nowDate();

    await insertMessages({ installationId, messages: 3, createdAt: oldDate });
    await insertMessages({
      installationId,
      messages: 2,
      createdAt: recentDate,
    });

    await expect(countMessages(installationId)).resolves.toBe(5);

    const response = await accept(
      apiClient().cleanup({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body.deleted).toBeGreaterThanOrEqual(3);
    await expect(countMessages(installationId)).resolves.toBe(2);
  });

  it("does not delete messages within the retention window", async () => {
    const fixture = await track(seedInstallation());
    const installationId = fixture.telegramBotIds[0] ?? "";
    const recentDate = nowDate();
    recentDate.setDate(recentDate.getDate() - 29);

    await insertMessages({
      installationId,
      messages: 5,
      createdAt: recentDate,
    });

    const response = await accept(
      apiClient().cleanup({ headers: cronHeaders() }),
      [200],
    );

    expect(typeof response.body.deleted).toBe("number");
    await expect(countMessages(installationId)).resolves.toBe(5);
  });
});
