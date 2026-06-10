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

// BDD migration of the legacy `cron-telegram-cleanup.test.ts`.
// The 5 legacy `it()`s collapse into 2 BDD `it()`s: (1) auth
// chain (401 wrong secret → 401 no header), (2) success
// chain (200 happy path with recent messages preserved → 200
// deletes messages older than 30 days → 200 does not delete
// messages within the retention window).
//
// Service-Level Exception: `telegramMessages` rows are
// inserted directly via `writeDb$` because no public route
// creates them.

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

describe("BDD GET /api/cron/telegram-cleanup — auth chain", () => {
  const track = createFixtureTracker<TelegramFixture>(cleanupFixture);

  beforeEach(() => {
    mockEnv("CRON_SECRET", "test-cron-secret");
    mockNow(FIXED_NOW_MS);
  });

  afterEach(() => {
    clearMockNow();
  });

  it("gwt-wt-wt: 401 wrong secret → 401 no auth header", async () => {
    // When + Then: 401 — invalid cron secret.
    const wrongSecret = await accept(
      apiClient().cleanup({ headers: cronHeaders("wrong-secret") }),
      [401],
    );
    expect(wrongSecret.body).toStrictEqual({
      error: { message: "Invalid cron secret", code: "UNAUTHORIZED" },
    });

    // When + Then: 401 — no auth header.
    const noHeader = await accept(
      apiClient().cleanup({ headers: {} }),
      [401],
    );
    expect(noHeader.body).toStrictEqual({
      error: { message: "Invalid cron secret", code: "UNAUTHORIZED" },
    });
  });
});

describe("BDD GET /api/cron/telegram-cleanup — 200 success chain", () => {
  const track = createFixtureTracker<TelegramFixture>(cleanupFixture);

  beforeEach(() => {
    mockEnv("CRON_SECRET", "test-cron-secret");
    mockNow(FIXED_NOW_MS);
  });

  afterEach(() => {
    clearMockNow();
  });

  it("gwt-wt-wt: 200 preserves recent messages → 200 deletes messages older than 30 days → 200 does not delete messages within the retention window", async () => {
    // Given: a fresh installation with 2 recent messages.
    const recentFixture = await track(seedInstallation());
    const recentId = recentFixture.telegramBotIds[0] ?? "";
    await insertMessages({
      installationId: recentId,
      messages: 2,
      createdAt: nowDate(),
    });

    // When + Then: 200 — recent messages are preserved.
    const recentResponse = await accept(
      apiClient().cleanup({ headers: cronHeaders() }),
      [200],
    );
    expect(typeof recentResponse.body.deleted).toBe("number");
    await expect(countMessages(recentId)).resolves.toBe(2);

    // Given: an installation with 3 old (>30d) and 2 recent
    // messages.
    const oldFixture = await track(seedInstallation());
    const oldId = oldFixture.telegramBotIds[0] ?? "";
    const oldDate = nowDate();
    oldDate.setDate(oldDate.getDate() - 31);
    const recentDate = nowDate();

    await insertMessages({ installationId: oldId, messages: 3, createdAt: oldDate });
    await insertMessages({
      installationId: oldId,
      messages: 2,
      createdAt: recentDate,
    });

    await expect(countMessages(oldId)).resolves.toBe(5);

    // When + Then: 200 — old messages are deleted; recent
    // ones remain.
    const oldResponse = await accept(
      apiClient().cleanup({ headers: cronHeaders() }),
      [200],
    );
    expect(oldResponse.body.deleted).toBeGreaterThanOrEqual(3);
    await expect(countMessages(oldId)).resolves.toBe(2);

    // Given: an installation with 5 messages within the
    // retention window (29 days old).
    const windowFixture = await track(seedInstallation());
    const windowId = windowFixture.telegramBotIds[0] ?? "";
    const windowDate = nowDate();
    windowDate.setDate(windowDate.getDate() - 29);
    await insertMessages({
      installationId: windowId,
      messages: 5,
      createdAt: windowDate,
    });

    // When + Then: 200 — nothing within the retention window
    // is deleted.
    const windowResponse = await accept(
      apiClient().cleanup({ headers: cronHeaders() }),
      [200],
    );
    expect(typeof windowResponse.body.deleted).toBe("number");
    await expect(countMessages(windowId)).resolves.toBe(5);
  });
});
