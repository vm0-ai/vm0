import { randomUUID } from "node:crypto";

import { zeroUsageRecordContract } from "@vm0/api-contracts/contracts/zero-usage-record";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockNow, nowDate } from "../../../lib/time";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteUsageFixture$,
  insertModelUsage$,
  insertUsageEvent$,
  seedChatThreadRun$,
  seedRun$,
  seedUsageFixture$,
  type UsageFixture,
} from "./helpers/zero-usage";
import { writeDb$ } from "../../external/db";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function apiClient() {
  return setupApp({ context })(zeroUsageRecordContract);
}

function userIdsFromClerkRequest(args: unknown): string[] {
  if (typeof args !== "object" || args === null) {
    return [];
  }
  const value = Reflect.get(args, "userId");
  if (
    Array.isArray(value) &&
    value.every((item): item is string => {
      return typeof item === "string";
    })
  ) {
    return value;
  }
  return [];
}

function mockClerkUserLookup(): void {
  context.mocks.clerk.users.getUserList.mockImplementation((args: unknown) => {
    return Promise.resolve({
      data: userIdsFromClerkRequest(args).map((userId) => {
        const emailId = `email_${userId}`;
        return {
          id: userId,
          primaryEmailAddressId: emailId,
          emailAddresses: [
            { id: emailId, emailAddress: `${userId}@example.com` },
          ],
        };
      }),
    });
  });
}

function createdAt(minutesAgo: number): Date {
  return new Date(nowDate().getTime() - minutesAgo * 60 * 1000);
}

async function enableCreditUsageRecords(fixture: UsageFixture): Promise<void> {
  const db = store.set(writeDb$);
  await db.insert(userFeatureSwitches).values({
    orgId: fixture.orgId,
    userId: fixture.userId,
    switches: { [FeatureSwitchKey.CreditUsageRecords]: true },
  });
}

async function disableCreditUsageRecords(fixture: UsageFixture): Promise<void> {
  const db = store.set(writeDb$);
  await db.insert(userFeatureSwitches).values({
    orgId: fixture.orgId,
    userId: fixture.userId,
    switches: { [FeatureSwitchKey.CreditUsageRecords]: false },
  });
}

describe("GET /api/zero/usage/record", () => {
  const track = createFixtureTracker<UsageFixture>((fixture) => {
    return store.set(deleteUsageFixture$, fixture, context.signal);
  });

  it("returns 401 when not authenticated", async () => {
    const response = await accept(
      apiClient().get({ query: {}, headers: {} }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 400 for invalid timezone values", async () => {
    const fixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().get({
        query: { tz: "Not/A/Timezone" },
        headers: authHeaders(),
      }),
      [400],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Invalid timezone: Not/A/Timezone",
        code: "BAD_REQUEST",
      },
    });
  });

  it("returns 403 when team usage records are requested", async () => {
    const fixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    await enableCreditUsageRecords(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const response = await accept(
      apiClient().get({
        query: { scope: "team", range: "7d", tz: "UTC" },
        headers: authHeaders(),
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Team usage records are aggregated by member",
        code: "FORBIDDEN",
      },
    });
  });

  it("returns 403 for ranged usage when credit usage records are disabled", async () => {
    const fixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    await disableCreditUsageRecords(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().get({
        query: { range: "7d", tz: "UTC" },
        headers: authHeaders(),
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Credit usage records are not enabled",
        code: "FORBIDDEN",
      },
    });
  });

  it("returns rows across sources ordered by recent activity", async () => {
    const fixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    await enableCreditUsageRecords(fixture);

    const older = await store.set(
      seedChatThreadRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        title: "Older chat",
        createdAt: createdAt(120),
      },
      context.signal,
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId: older.runId,
        inputTokens: 100,
        outputTokens: 50,
        creditsCharged: 80,
      },
      context.signal,
    );

    // Unthreaded Slack run — one row per run, links via runId.
    const slack = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        prompt: "Slack triage",
        triggerSource: "slack",
        createdAt: createdAt(60),
      },
      context.signal,
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId: slack.runId,
        inputTokens: 30,
        outputTokens: 20,
        creditsCharged: 40,
      },
      context.signal,
    );

    const newer = await store.set(
      seedChatThreadRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        title: "Newer chat",
        createdAt: createdAt(5),
      },
      context.signal,
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId: newer.runId,
        inputTokens: 200,
        outputTokens: 100,
        creditsCharged: 250,
      },
      context.signal,
    );

    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().get({ query: {}, headers: authHeaders() }),
      [200],
    );

    expect(response.body.rows).toHaveLength(3);
    expect(response.body.pagination.total).toBe(3);
    expect(response.body.period).not.toBeNull();

    expect(response.body.rows[0]?.source).toBe("chat");
    expect(response.body.rows[0]?.threadId).toBe(newer.threadId);
    expect(response.body.rows[0]?.runId).toBeNull();
    expect(response.body.rows[0]?.title).toBe("Newer chat");
    expect(response.body.rows[0]?.credits).toBe(250);
    expect(response.body.rows[0]?.tokens).toBe(300);
    expect(response.body.rows[0]?.breakdown).toStrictEqual([
      {
        kind: "model",
        credits: 250,
        providers: [{ provider: "claude-sonnet-4-6", credits: 250 }],
      },
    ]);
    expect(response.body.rows[0]?.member).toBeNull();

    expect(response.body.rows[1]?.source).toBe("slack");
    expect(response.body.rows[1]?.threadId).toBeNull();
    expect(response.body.rows[1]?.runId).toBe(slack.runId);
    expect(response.body.rows[1]?.title).toBe("Slack triage");
    expect(response.body.rows[1]?.credits).toBe(40);

    expect(response.body.rows[2]?.source).toBe("chat");
    expect(response.body.rows[2]?.threadId).toBe(older.threadId);
    expect(response.body.rows[2]?.credits).toBe(80);
  });

  it("labels schedule threads and filters by source", async () => {
    const fixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    await enableCreditUsageRecords(fixture);

    const chat = await store.set(
      seedChatThreadRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        title: "A chat",
        createdAt: createdAt(20),
      },
      context.signal,
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId: chat.runId,
        inputTokens: 10,
        outputTokens: 10,
        creditsCharged: 10,
      },
      context.signal,
    );

    const schedule = await store.set(
      seedChatThreadRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        title: "Daily brief",
        triggerSource: "schedule",
        createdAt: createdAt(10),
      },
      context.signal,
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId: schedule.runId,
        inputTokens: 50,
        outputTokens: 50,
        creditsCharged: 120,
      },
      context.signal,
    );

    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().get({
        query: { source: "schedule" },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.rows).toHaveLength(1);
    expect(response.body.pagination.total).toBe(1);
    expect(response.body.rows[0]?.source).toBe("schedule");
    expect(response.body.rows[0]?.threadId).toBe(schedule.threadId);
    expect(response.body.rows[0]?.title).toBe("Daily brief");
    expect(response.body.rows[0]?.credits).toBe(120);
  });

  it("keeps chat and schedule usage separate within the same thread", async () => {
    const fixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    await enableCreditUsageRecords(fixture);

    const chat = await store.set(
      seedChatThreadRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        title: "Shared thread",
        createdAt: createdAt(30),
      },
      context.signal,
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId: chat.runId,
        inputTokens: 10,
        outputTokens: 10,
        creditsCharged: 10,
      },
      context.signal,
    );

    const schedule = await store.set(
      seedChatThreadRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        threadId: chat.threadId,
        triggerSource: "schedule",
        createdAt: createdAt(5),
      },
      context.signal,
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId: schedule.runId,
        inputTokens: 50,
        outputTokens: 50,
        creditsCharged: 120,
      },
      context.signal,
    );

    mocks.clerk.session(fixture.userId, fixture.orgId);

    const allResponse = await accept(
      apiClient().get({ query: {}, headers: authHeaders() }),
      [200],
    );
    expect(allResponse.body.rows).toHaveLength(2);
    expect(allResponse.body.pagination.total).toBe(2);
    expect(allResponse.body.rows[0]).toMatchObject({
      source: "schedule",
      threadId: chat.threadId,
      runId: null,
      title: "Shared thread",
      credits: 120,
      tokens: 100,
    });
    expect(allResponse.body.rows[1]).toMatchObject({
      source: "chat",
      threadId: chat.threadId,
      runId: null,
      title: "Shared thread",
      credits: 10,
      tokens: 20,
    });

    const chatResponse = await accept(
      apiClient().get({
        query: { source: "chat" },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(chatResponse.body.rows).toHaveLength(1);
    expect(chatResponse.body.rows[0]?.source).toBe("chat");
    expect(chatResponse.body.rows[0]?.credits).toBe(10);
  });

  it("normalizes unsupported trigger sources to other", async () => {
    const fixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    await enableCreditUsageRecords(fixture);

    const legacyRun = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        prompt: "Legacy manual run",
        triggerSource: "manual",
        createdAt: createdAt(10),
      },
      context.signal,
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId: legacyRun.runId,
        inputTokens: 25,
        outputTokens: 5,
        creditsCharged: 30,
      },
      context.signal,
    );

    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().get({
        query: { source: "other" },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.rows).toHaveLength(1);
    expect(response.body.pagination.total).toBe(1);
    expect(response.body.rows[0]).toMatchObject({
      source: "other",
      threadId: null,
      runId: legacyRun.runId,
      title: "Legacy manual run",
      credits: 30,
      tokens: 30,
    });
  });

  it("paginates by page size", async () => {
    const fixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    await enableCreditUsageRecords(fixture);

    for (const minutesAgo of [30, 20, 10]) {
      const chat = await store.set(
        seedChatThreadRun$,
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          title: `Chat ${minutesAgo}`,
          createdAt: createdAt(minutesAgo),
        },
        context.signal,
      );
      await store.set(
        insertModelUsage$,
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          runId: chat.runId,
          inputTokens: 10,
          outputTokens: 10,
          creditsCharged: 10,
        },
        context.signal,
      );
    }

    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().get({
        query: { page: 1, pageSize: 2 },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.rows).toHaveLength(2);
    expect(response.body.pagination.total).toBe(3);
    expect(response.body.rows[0]?.title).toBe("Chat 10");
    expect(response.body.rows[1]?.title).toBe("Chat 20");
  });

  it("filters usage by fixed ranges in the requested timezone", async () => {
    mockNow(new Date("2026-03-15T08:30:00.000Z"));
    const fixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    await enableCreditUsageRecords(fixture);

    const today = await store.set(
      seedChatThreadRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        title: "Shanghai today",
        createdAt: new Date("2026-03-15T01:00:00.000Z"),
      },
      context.signal,
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId: today.runId,
        inputTokens: 20,
        outputTokens: 10,
        creditsCharged: 30,
        createdAt: new Date("2026-03-15T01:00:00.000Z"),
      },
      context.signal,
    );

    const yesterday = await store.set(
      seedChatThreadRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        title: "Shanghai yesterday",
        createdAt: new Date("2026-03-14T01:00:00.000Z"),
      },
      context.signal,
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId: yesterday.runId,
        inputTokens: 10,
        outputTokens: 10,
        creditsCharged: 20,
        createdAt: new Date("2026-03-14T01:00:00.000Z"),
      },
      context.signal,
    );

    mocks.clerk.session(fixture.userId, fixture.orgId);

    const todayResponse = await accept(
      apiClient().get({
        query: { range: "today", tz: "Asia/Shanghai" },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(todayResponse.body.period).toStrictEqual({
      start: "2026-03-14T16:00:00.000Z",
      end: "2026-03-15T08:30:00.000Z",
    });
    expect(
      todayResponse.body.rows.map((row) => {
        return row.title;
      }),
    ).toStrictEqual(["Shanghai today"]);

    const yesterdayResponse = await accept(
      apiClient().get({
        query: { range: "yesterday", tz: "Asia/Shanghai" },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(yesterdayResponse.body.period).toStrictEqual({
      start: "2026-03-13T16:00:00.000Z",
      end: "2026-03-14T16:00:00.000Z",
    });
    expect(
      yesterdayResponse.body.rows.map((row) => {
        return row.title;
      }),
    ).toStrictEqual(["Shanghai yesterday"]);
  });

  it("resolves yesterday as the previous calendar day across DST boundaries", async () => {
    mockNow(new Date("2026-03-09T12:00:00.000Z"));
    const fixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    await enableCreditUsageRecords(fixture);

    const previousDay = await store.set(
      seedChatThreadRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        title: "DST previous day",
        createdAt: new Date("2026-03-08T05:30:00.000Z"),
      },
      context.signal,
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId: previousDay.runId,
        inputTokens: 10,
        outputTokens: 10,
        creditsCharged: 20,
        createdAt: new Date("2026-03-08T05:30:00.000Z"),
      },
      context.signal,
    );

    const strayPriorDay = await store.set(
      seedChatThreadRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        title: "DST stray prior day",
        createdAt: new Date("2026-03-08T04:30:00.000Z"),
      },
      context.signal,
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId: strayPriorDay.runId,
        inputTokens: 10,
        outputTokens: 10,
        creditsCharged: 20,
        createdAt: new Date("2026-03-08T04:30:00.000Z"),
      },
      context.signal,
    );

    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().get({
        query: { range: "yesterday", tz: "America/New_York" },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.period).toStrictEqual({
      start: "2026-03-08T05:00:00.000Z",
      end: "2026-03-09T04:00:00.000Z",
    });
    expect(
      response.body.rows.map((row) => {
        return row.title;
      }),
    ).toStrictEqual(["DST previous day"]);
  });

  it("does not return team usage rows with conversation details for admins", async () => {
    const fixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    await enableCreditUsageRecords(fixture);
    const teammateId = `user_${randomUUID()}`;
    mockClerkUserLookup();

    const mine = await store.set(
      seedChatThreadRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        title: "Admin chat",
        createdAt: createdAt(20),
      },
      context.signal,
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId: mine.runId,
        inputTokens: 10,
        outputTokens: 10,
        creditsCharged: 20,
      },
      context.signal,
    );

    const teammate = await store.set(
      seedChatThreadRun$,
      {
        orgId: fixture.orgId,
        userId: teammateId,
        title: "Teammate chat",
        createdAt: createdAt(10),
      },
      context.signal,
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: fixture.orgId,
        userId: teammateId,
        runId: teammate.runId,
        inputTokens: 20,
        outputTokens: 10,
        creditsCharged: 40,
      },
      context.signal,
    );

    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const response = await accept(
      apiClient().get({
        query: { scope: "team", range: "7d", tz: "UTC" },
        headers: authHeaders(),
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Team usage records are aggregated by member",
        code: "FORBIDDEN",
      },
    });
  });

  it("returns kind and provider breakdowns for each usage row", async () => {
    const fixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    await enableCreditUsageRecords(fixture);

    const run = await store.set(
      seedChatThreadRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        title: "Mixed media chat",
        createdAt: createdAt(5),
      },
      context.signal,
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId: run.runId,
        inputTokens: 100,
        outputTokens: 50,
        creditsCharged: 80,
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId: run.runId,
        kind: "image",
        provider: "gpt-image-2",
        category: "tokens.output.image",
        quantity: 1,
        creditsCharged: 120,
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        runId: run.runId,
        kind: "custom",
        provider: "legacy",
        category: "legacy.usage",
        quantity: 1,
        creditsCharged: 15,
      },
      context.signal,
    );

    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().get({
        query: { range: "7d", tz: "UTC" },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.rows[0]?.credits).toBe(215);
    expect(response.body.rows[0]?.breakdown).toStrictEqual([
      {
        kind: "model",
        credits: 80,
        providers: [{ provider: "claude-sonnet-4-6", credits: 80 }],
      },
      {
        kind: "image",
        credits: 120,
        providers: [{ provider: "gpt-image-2", credits: 120 }],
      },
      {
        kind: "other",
        credits: 15,
        providers: [{ provider: "legacy", credits: 15 }],
      },
    ]);
  });

  it("returns an empty null-period response for free billing period usage", async () => {
    const fixture = await track(
      store.set(seedUsageFixture$, {}, context.signal),
    );
    await enableCreditUsageRecords(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().get({
        query: { range: "billingPeriod", tz: "UTC" },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      period: null,
      rows: [],
      pagination: { page: 1, pageSize: 20, total: 0 },
    });
  });
});
