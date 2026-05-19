import { cronVoiceChatCleanupContract } from "@vm0/api-contracts/contracts/cron";
import { voiceChatSessions } from "@vm0/db/schema/voice-chat";
import { createStore } from "ccstate";
import { and, count, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { clearMockNow, mockNow, nowDate } from "../../../lib/time";
import { writeDb$ } from "../../external/db";
import { clearAllDetached } from "../../utils";
import {
  deleteVoiceChatFixture$,
  seedVoiceChatFixture$,
  type VoiceChatFixture,
} from "./helpers/zero-voice-chat";
import { createFixtureTracker } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const FIXED_NOW_MS = Date.UTC(2026, 4, 14, 12, 0, 0);

type ReasoningStatus = "idle" | "running";

function apiClient() {
  return setupApp({ context })(cronVoiceChatCleanupContract);
}

function cronHeaders(secret = "test-cron-secret") {
  return { authorization: `Bearer ${secret}` };
}

async function cleanupFixture(fixture: VoiceChatFixture): Promise<void> {
  await store.set(deleteVoiceChatFixture$, fixture, context.signal);
}

function minutesAgo(minutes: number, extraMs = 0): Date {
  const date = nowDate();
  date.setTime(date.getTime() - minutes * 60 * 1000 - extraMs);
  return date;
}

async function insertSession(args: {
  readonly fixture: VoiceChatFixture;
  readonly userId?: string;
  readonly reasoningStatus: ReasoningStatus;
  readonly lastSummaryAt: Date;
}): Promise<string> {
  const db = store.set(writeDb$);
  const [row] = await db
    .insert(voiceChatSessions)
    .values({
      orgId: args.fixture.orgId,
      userId: args.userId ?? args.fixture.userId,
      reasoningStatus: args.reasoningStatus,
      lastSummaryAt: args.lastSummaryAt,
    })
    .returning({ id: voiceChatSessions.id });

  if (!row) {
    throw new Error("insertSession: insert returned no row");
  }

  return row.id;
}

async function findSession(sessionId: string): Promise<{
  readonly reasoningStatus: string;
  readonly lastSummaryAt: Date | null;
  readonly lastReasoningDurationMs: number | null;
} | null> {
  const db = store.set(writeDb$);
  const [row] = await db
    .select({
      reasoningStatus: voiceChatSessions.reasoningStatus,
      lastSummaryAt: voiceChatSessions.lastSummaryAt,
      lastReasoningDurationMs: voiceChatSessions.lastReasoningDurationMs,
    })
    .from(voiceChatSessions)
    .where(eq(voiceChatSessions.id, sessionId))
    .limit(1);
  return row ?? null;
}

async function countSessionsByStatus(
  fixture: VoiceChatFixture,
  reasoningStatus: ReasoningStatus,
): Promise<number> {
  const db = store.set(writeDb$);
  const [row] = await db
    .select({ value: count() })
    .from(voiceChatSessions)
    .where(
      and(
        eq(voiceChatSessions.orgId, fixture.orgId),
        eq(voiceChatSessions.reasoningStatus, reasoningStatus),
      ),
    );
  return row?.value ?? 0;
}

describe("GET /api/cron/voice-chat-cleanup", () => {
  const track = createFixtureTracker<VoiceChatFixture>(cleanupFixture);

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

  it("rejects requests with no authorization header", async () => {
    const response = await accept(apiClient().cleanup({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: { message: "Invalid cron secret", code: "UNAUTHORIZED" },
    });
  });

  it("resets a stuck reasoner and queues a reasoning re-tick", async () => {
    const fixture = await track(
      store.set(seedVoiceChatFixture$, {}, context.signal),
    );
    const sessionId = await insertSession({
      fixture,
      reasoningStatus: "running",
      lastSummaryAt: minutesAgo(5, 1),
    });

    const response = await accept(
      apiClient().cleanup({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body.success).toBeTruthy();
    expect(response.body.reasonerReset).toBeGreaterThanOrEqual(1);
    await clearAllDetached();
    await expect(findSession(sessionId)).resolves.toMatchObject({
      reasoningStatus: "idle",
      lastReasoningDurationMs: expect.any(Number),
    });
  });

  it("does not touch a non-stuck reasoner", async () => {
    const fixture = await track(
      store.set(seedVoiceChatFixture$, {}, context.signal),
    );
    const freshReasoningAt = minutesAgo(2);
    const sessionId = await insertSession({
      fixture,
      reasoningStatus: "running",
      lastSummaryAt: freshReasoningAt,
    });

    const response = await accept(
      apiClient().cleanup({ headers: cronHeaders() }),
      [200],
    );

    expect(response.body.reasonerReset).toBe(0);
    await expect(findSession(sessionId)).resolves.toStrictEqual({
      reasoningStatus: "running",
      lastSummaryAt: freshReasoningAt,
      lastReasoningDurationMs: null,
    });
  });

  it("caps stuck reasoner recovery at 50 sessions per tick", async () => {
    const fixture = await track(
      store.set(seedVoiceChatFixture$, {}, context.signal),
    );
    const staleReasoningAt = minutesAgo(5, 1);

    for (let index = 0; index < 60; index++) {
      await insertSession({
        fixture,
        userId: `user_${index.toString()}`,
        reasoningStatus: "running",
        lastSummaryAt: staleReasoningAt,
      });
    }

    const first = await accept(
      apiClient().cleanup({ headers: cronHeaders() }),
      [200],
    );

    expect(first.body.reasonerReset).toBe(50);
    await clearAllDetached();
    await expect(countSessionsByStatus(fixture, "running")).resolves.toBe(10);
    await expect(countSessionsByStatus(fixture, "idle")).resolves.toBe(50);

    const second = await accept(
      apiClient().cleanup({ headers: cronHeaders() }),
      [200],
    );

    expect(second.body.reasonerReset).toBeGreaterThanOrEqual(10);
    await clearAllDetached();
    await expect(countSessionsByStatus(fixture, "running")).resolves.toBe(0);
    await expect(countSessionsByStatus(fixture, "idle")).resolves.toBe(60);
  });
});
