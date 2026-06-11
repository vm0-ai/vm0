import { randomUUID } from "node:crypto";

import { zeroUsageMembersContract } from "@vm0/api-contracts/contracts/zero-usage";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { nowDate } from "../../../lib/time";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteUsageFixture$,
  insertModelUsage$,
  insertUsageEvent$,
  REALTIME_PROVIDER,
  REALTIME_TOKEN_CATEGORIES,
  seedUsageFixture$,
  TRANSCRIPTION_PROVIDER,
  TRANSCRIPTION_TOKEN_CATEGORIES,
  type UsageFixture,
} from "./helpers/zero-usage";

// BDD migration of the legacy `zero-usage-members.test.ts`.
// The 8 legacy `it()`s collapse into 3 BDD `it()`s: (1)
// auth + empty + pending exclusion chain (401
// unauthenticated → 200 empty result for free tier with
// no billing period → 200 excludes pending records from
// aggregation), (2) aggregation chain (200 single user
// with processed records → 200 multiple users sorted by
// credits → 200 includes processed usage_event records in
// member totals), (3) token rollup + processedAt chain
// (200 rolls up Realtime and transcription categories
// into flat token totals → 200 uses processedAt for
// billing-period membership).

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function apiClient() {
  return setupApp({ context })(zeroUsageMembersContract);
}

function periodEndFromNow(): Date {
  return new Date(nowDate().getTime() + 30 * 24 * 60 * 60 * 1000);
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

function clerkUser(userId: string) {
  const emailId = `email_${userId}`;
  return {
    id: userId,
    primaryEmailAddressId: emailId,
    emailAddresses: [{ id: emailId, emailAddress: `${userId}@example.com` }],
  };
}

function mockClerkUserLookup(): void {
  context.mocks.clerk.users.getUserList.mockImplementation((args: unknown) => {
    return Promise.resolve({
      data: userIdsFromClerkRequest(args).map((userId) => {
        return clerkUser(userId);
      }),
    });
  });
}

const track = createFixtureTracker<UsageFixture>((fixture) => {
  return store.set(deleteUsageFixture$, fixture, context.signal);
});

describe("BDD GET /api/zero/usage/members — auth + empty + pending chain", () => {
  it("gwt-wt-wt: 401 unauthenticated → 200 empty result for free tier with no billing period → 200 excludes pending records from aggregation", async () => {
    // Given: no auth header.

    // When + Then: 401.
    const noAuth = await accept(apiClient().get({ headers: {} }), [401]);
    expect(noAuth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a free-tier fixture with no billing period.

    // When + Then: 200 — empty result.
    const emptyFixture = await track(
      store.set(seedUsageFixture$, { currentPeriodEnd: null }, context.signal),
    );
    mocks.clerk.session(emptyFixture.userId, emptyFixture.orgId);
    const emptyResponse = await accept(
      apiClient().get({ headers: authHeaders() }),
      [200],
    );
    expect(emptyResponse.body).toStrictEqual({ period: null, members: [] });

    // Given: a pro-tier fixture + a processed + a pending
    // model usage.

    // When + Then: 200 — pending record is excluded.
    mockClerkUserLookup();
    const pendingFixture = await track(
      store.set(
        seedUsageFixture$,
        { currentPeriodEnd: periodEndFromNow(), tier: "pro" },
        context.signal,
      ),
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: pendingFixture.orgId,
        userId: pendingFixture.userId,
        inputTokens: 1000,
        creditsCharged: 50,
      },
      context.signal,
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: pendingFixture.orgId,
        userId: pendingFixture.userId,
        inputTokens: 5000,
        creditsCharged: 0,
        status: "pending",
      },
      context.signal,
    );
    mocks.clerk.session(pendingFixture.userId, pendingFixture.orgId);
    const pendingResponse = await accept(
      apiClient().get({ headers: authHeaders() }),
      [200],
    );
    expect(pendingResponse.body.members).toHaveLength(1);
    expect(pendingResponse.body.members[0]).toMatchObject({
      inputTokens: 1000,
      creditsCharged: 50,
    });
  });
});

describe("BDD GET /api/zero/usage/members — aggregation chain", () => {
  it("gwt-wt-wt: 200 single user with processed records → 200 multiple users sorted by credits → 200 includes processed usage_event records in member totals", async () => {
    // Given: a pro-tier fixture + 2 processed model usage
    // rows for a single user.

    // When + Then: 200 — single member with summed tokens
    // + credits.
    mockClerkUserLookup();
    const singleFixture = await track(
      store.set(
        seedUsageFixture$,
        { currentPeriodEnd: periodEndFromNow(), tier: "pro" },
        context.signal,
      ),
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: singleFixture.orgId,
        userId: singleFixture.userId,
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadInputTokens: 200,
        cacheCreationInputTokens: 100,
        creditsCharged: 50,
      },
      context.signal,
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: singleFixture.orgId,
        userId: singleFixture.userId,
        inputTokens: 2000,
        outputTokens: 1000,
        cacheReadInputTokens: 300,
        cacheCreationInputTokens: 150,
        creditsCharged: 100,
      },
      context.signal,
    );
    mocks.clerk.session(singleFixture.userId, singleFixture.orgId);
    const singleResponse = await accept(
      apiClient().get({ headers: authHeaders() }),
      [200],
    );
    expect(singleResponse.body.period).not.toBeNull();
    expect(singleResponse.body.members).toHaveLength(1);
    expect(singleResponse.body.members[0]).toMatchObject({
      userId: singleFixture.userId,
      email: `${singleFixture.userId}@example.com`,
      inputTokens: 3000,
      outputTokens: 1500,
      cacheReadInputTokens: 500,
      cacheCreationInputTokens: 250,
      creditsCharged: 150,
    });

    // Given: a pro-tier fixture + model usage for 2 users
    // with different credit totals.

    // When + Then: 200 — 2 members sorted by credits
    // (descending).
    mockClerkUserLookup();
    const multiFixture = await track(
      store.set(
        seedUsageFixture$,
        { currentPeriodEnd: periodEndFromNow(), tier: "pro" },
        context.signal,
      ),
    );
    const user1 = `user_${randomUUID()}`;
    const user2 = `user_${randomUUID()}`;
    await store.set(
      insertModelUsage$,
      {
        orgId: multiFixture.orgId,
        userId: user1,
        inputTokens: 1000,
        outputTokens: 500,
        creditsCharged: 50,
      },
      context.signal,
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: multiFixture.orgId,
        userId: user2,
        inputTokens: 3000,
        outputTokens: 1500,
        creditsCharged: 200,
      },
      context.signal,
    );
    mocks.clerk.session(multiFixture.userId, multiFixture.orgId);
    const multiResponse = await accept(
      apiClient().get({ headers: authHeaders() }),
      [200],
    );
    expect(multiResponse.body.members).toHaveLength(2);
    expect(multiResponse.body.members[0]?.userId).toBe(user2);
    expect(multiResponse.body.members[0]?.creditsCharged).toBe(200);
    expect(multiResponse.body.members[1]?.userId).toBe(user1);
    expect(multiResponse.body.members[1]?.creditsCharged).toBe(50);

    // Given: a pro-tier fixture + 1 model usage + 6 usage
    // events (4 token categories, 1 bare credit, 1
    // pending) for 2 users.

    // When + Then: 200 — 2 members, the mixed user merges
    // model + processed events, the event-only user has 0
    // tokens + only credits, and the pending event is
    // excluded.
    mockClerkUserLookup();
    const eventsFixture = await track(
      store.set(
        seedUsageFixture$,
        { currentPeriodEnd: periodEndFromNow(), tier: "pro" },
        context.signal,
      ),
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: eventsFixture.orgId,
        userId: eventsFixture.userId,
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadInputTokens: 200,
        cacheCreationInputTokens: 100,
        creditsCharged: 50,
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        orgId: eventsFixture.orgId,
        userId: eventsFixture.userId,
        kind: "model",
        provider: "claude-sonnet-4-6",
        category: "tokens.input",
        quantity: 300,
        creditsCharged: 30,
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        orgId: eventsFixture.orgId,
        userId: eventsFixture.userId,
        kind: "model",
        provider: "claude-sonnet-4-6",
        category: "tokens.output",
        quantity: 120,
        creditsCharged: 12,
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        orgId: eventsFixture.orgId,
        userId: eventsFixture.userId,
        kind: "model",
        provider: "claude-sonnet-4-6",
        category: "tokens.cache_read",
        quantity: 80,
        creditsCharged: 8,
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        orgId: eventsFixture.orgId,
        userId: eventsFixture.userId,
        kind: "model",
        provider: "claude-sonnet-4-6",
        category: "tokens.cache_creation",
        quantity: 40,
        creditsCharged: 4,
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        orgId: eventsFixture.orgId,
        userId: eventsFixture.userId,
        creditsCharged: 20,
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        orgId: eventsFixture.orgId,
        userId: eventsFixture.userId,
        kind: "model",
        provider: "claude-sonnet-4-6",
        category: "tokens.input",
        quantity: 9999,
        creditsCharged: 999,
        status: "pending",
      },
      context.signal,
    );
    const eventOnlyUserId = `user_${randomUUID()}`;
    await store.set(
      insertUsageEvent$,
      {
        orgId: eventsFixture.orgId,
        userId: eventOnlyUserId,
        creditsCharged: 200,
      },
      context.signal,
    );
    mocks.clerk.session(eventsFixture.userId, eventsFixture.orgId);
    const eventsResponse = await accept(
      apiClient().get({ headers: authHeaders() }),
      [200],
    );
    expect(eventsResponse.body.members).toHaveLength(2);
    const mixedMember = eventsResponse.body.members.find((member) => {
      return member.userId === eventsFixture.userId;
    });
    expect(mixedMember).toMatchObject({
      inputTokens: 1300,
      outputTokens: 620,
      cacheReadInputTokens: 280,
      cacheCreationInputTokens: 140,
      creditsCharged: 124,
    });
    const eventOnlyMember = eventsResponse.body.members.find((member) => {
      return member.userId === eventOnlyUserId;
    });
    expect(eventOnlyMember).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      creditsCharged: 200,
    });
  });
});

describe("BDD GET /api/zero/usage/members — token rollup + processedAt chain", () => {
  it("gwt-wt-wt: 200 rolls up Realtime and transcription categories into flat token totals → 200 uses processedAt for billing-period membership", async () => {
    // Given: a pro-tier fixture + Realtime + transcription
    // token events.

    // When + Then: 200 — the Realtime + transcription
    // categories are rolled up into flat token totals.
    mockClerkUserLookup();
    const realtimeFixture = await track(
      store.set(
        seedUsageFixture$,
        { currentPeriodEnd: periodEndFromNow(), tier: "pro" },
        context.signal,
      ),
    );
    const realtimeQuantities: Record<
      (typeof REALTIME_TOKEN_CATEGORIES)[number],
      number
    > = {
      "tokens.input.text": 100,
      "tokens.input.audio": 200,
      "tokens.input.cached_text": 30,
      "tokens.input.cached_audio": 70,
      "tokens.output.text": 40,
      "tokens.output.audio": 60,
    };
    for (const category of REALTIME_TOKEN_CATEGORIES) {
      await store.set(
        insertUsageEvent$,
        {
          orgId: realtimeFixture.orgId,
          userId: realtimeFixture.userId,
          kind: "model",
          provider: REALTIME_PROVIDER,
          category,
          quantity: realtimeQuantities[category],
        },
        context.signal,
      );
    }
    const transcriptionQuantities: Record<
      (typeof TRANSCRIPTION_TOKEN_CATEGORIES)[number],
      number
    > = {
      "tokens.input.audio": 500,
      "tokens.input.text": 25,
      "tokens.output.text": 15,
    };
    for (const category of TRANSCRIPTION_TOKEN_CATEGORIES) {
      await store.set(
        insertUsageEvent$,
        {
          orgId: realtimeFixture.orgId,
          userId: realtimeFixture.userId,
          kind: "model",
          provider: TRANSCRIPTION_PROVIDER,
          category,
          quantity: transcriptionQuantities[category],
        },
        context.signal,
      );
    }
    mocks.clerk.session(realtimeFixture.userId, realtimeFixture.orgId);
    const realtimeResponse = await accept(
      apiClient().get({ headers: authHeaders() }),
      [200],
    );
    expect(realtimeResponse.body.members).toHaveLength(1);
    expect(realtimeResponse.body.members[0]).toMatchObject({
      inputTokens: 825,
      outputTokens: 115,
      cacheReadInputTokens: 100,
      cacheCreationInputTokens: 0,
    });

    // Given: a pro-tier fixture with explicit period
    // boundaries + 2 model usage rows + 1 usage event
    // whose processedAt falls in different periods.

    // When + Then: 200 — only records with processedAt
    // inside the current billing period are aggregated.
    mockClerkUserLookup();
    const periodEnd = new Date("2099-04-01T00:00:00.000Z");
    const periodStart = new Date("2099-03-01T00:00:00.000Z");
    const processedAtFixture = await track(
      store.set(
        seedUsageFixture$,
        { currentPeriodEnd: periodEnd, tier: "pro" },
        context.signal,
      ),
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: processedAtFixture.orgId,
        userId: processedAtFixture.userId,
        inputTokens: 10,
        outputTokens: 5,
        creditsCharged: 10,
        processedAt: periodStart,
      },
      context.signal,
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: processedAtFixture.orgId,
        userId: processedAtFixture.userId,
        inputTokens: 999,
        outputTokens: 999,
        creditsCharged: 999,
        processedAt: periodEnd,
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        orgId: processedAtFixture.orgId,
        userId: processedAtFixture.userId,
        kind: "model",
        provider: "claude-sonnet-4-6",
        category: "tokens.input",
        quantity: 999,
        creditsCharged: 999,
        processedAt: periodEnd,
      },
      context.signal,
    );
    mocks.clerk.session(processedAtFixture.userId, processedAtFixture.orgId);
    const processedAtResponse = await accept(
      apiClient().get({ headers: authHeaders() }),
      [200],
    );
    expect(processedAtResponse.body.members).toHaveLength(1);
    expect(processedAtResponse.body.members[0]).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      creditsCharged: 10,
    });
  });
});
