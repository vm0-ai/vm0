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
  setMemberCreditCap$,
  TRANSCRIPTION_PROVIDER,
  TRANSCRIPTION_TOKEN_CATEGORIES,
  type UsageFixture,
} from "./helpers/zero-usage";

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

describe("GET /api/zero/usage/members", () => {
  const track = createFixtureTracker<UsageFixture>((fixture) => {
    return store.set(deleteUsageFixture$, fixture, context.signal);
  });

  it("returns 401 when not authenticated", async () => {
    const response = await accept(apiClient().get({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns empty result for free tier org with no billing period", async () => {
    const fixture = await track(
      store.set(seedUsageFixture$, { currentPeriodEnd: null }, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().get({ headers: authHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({ period: null, members: [] });
  });

  it("returns aggregated usage for a single user with processed records", async () => {
    mockClerkUserLookup();
    const fixture = await track(
      store.set(
        seedUsageFixture$,
        { currentPeriodEnd: periodEndFromNow(), tier: "pro" },
        context.signal,
      ),
    );
    await store.set(
      setMemberCreditCap$,
      { orgId: fixture.orgId, userId: fixture.userId, creditCap: 250 },
      context.signal,
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
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
        orgId: fixture.orgId,
        userId: fixture.userId,
        inputTokens: 2000,
        outputTokens: 1000,
        cacheReadInputTokens: 300,
        cacheCreationInputTokens: 150,
        creditsCharged: 100,
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().get({ headers: authHeaders() }),
      [200],
    );

    expect(response.body.period).not.toBeNull();
    expect(response.body.members).toHaveLength(1);
    expect(response.body.members[0]).toMatchObject({
      userId: fixture.userId,
      email: `${fixture.userId}@example.com`,
      inputTokens: 3000,
      outputTokens: 1500,
      cacheReadInputTokens: 500,
      cacheCreationInputTokens: 250,
      creditsCharged: 150,
      creditCap: 250,
    });
  });

  it("returns separate aggregation for multiple users sorted by credits", async () => {
    mockClerkUserLookup();
    const fixture = await track(
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
        orgId: fixture.orgId,
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
        orgId: fixture.orgId,
        userId: user2,
        inputTokens: 3000,
        outputTokens: 1500,
        creditsCharged: 200,
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().get({ headers: authHeaders() }),
      [200],
    );

    expect(response.body.members).toHaveLength(2);
    expect(response.body.members[0]?.userId).toBe(user2);
    expect(response.body.members[0]?.creditsCharged).toBe(200);
    expect(response.body.members[1]?.userId).toBe(user1);
    expect(response.body.members[1]?.creditsCharged).toBe(50);
  });

  it("excludes pending records from aggregation", async () => {
    mockClerkUserLookup();
    const fixture = await track(
      store.set(
        seedUsageFixture$,
        { currentPeriodEnd: periodEndFromNow(), tier: "pro" },
        context.signal,
      ),
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        inputTokens: 1000,
        creditsCharged: 50,
      },
      context.signal,
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        inputTokens: 5000,
        creditsCharged: 0,
        status: "pending",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().get({ headers: authHeaders() }),
      [200],
    );

    expect(response.body.members).toHaveLength(1);
    expect(response.body.members[0]).toMatchObject({
      inputTokens: 1000,
      creditsCharged: 50,
    });
  });

  it("includes processed usage_event records in member totals", async () => {
    mockClerkUserLookup();
    const fixture = await track(
      store.set(
        seedUsageFixture$,
        { currentPeriodEnd: periodEndFromNow(), tier: "pro" },
        context.signal,
      ),
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
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
        orgId: fixture.orgId,
        userId: fixture.userId,
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
        orgId: fixture.orgId,
        userId: fixture.userId,
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
        orgId: fixture.orgId,
        userId: fixture.userId,
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
        orgId: fixture.orgId,
        userId: fixture.userId,
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
        orgId: fixture.orgId,
        userId: fixture.userId,
        creditsCharged: 20,
      },
      context.signal,
    );
    await store.set(
      insertUsageEvent$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
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
        orgId: fixture.orgId,
        userId: eventOnlyUserId,
        creditsCharged: 200,
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().get({ headers: authHeaders() }),
      [200],
    );

    expect(response.body.members).toHaveLength(2);
    const mixedMember = response.body.members.find((member) => {
      return member.userId === fixture.userId;
    });
    expect(mixedMember).toMatchObject({
      inputTokens: 1300,
      outputTokens: 620,
      cacheReadInputTokens: 280,
      cacheCreationInputTokens: 140,
      creditsCharged: 124,
    });

    const eventOnlyMember = response.body.members.find((member) => {
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

  it("rolls up Realtime and transcription categories into flat token totals", async () => {
    mockClerkUserLookup();
    const fixture = await track(
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
          orgId: fixture.orgId,
          userId: fixture.userId,
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
          orgId: fixture.orgId,
          userId: fixture.userId,
          kind: "model",
          provider: TRANSCRIPTION_PROVIDER,
          category,
          quantity: transcriptionQuantities[category],
        },
        context.signal,
      );
    }
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().get({ headers: authHeaders() }),
      [200],
    );

    expect(response.body.members).toHaveLength(1);
    expect(response.body.members[0]).toMatchObject({
      inputTokens: 825,
      outputTokens: 115,
      cacheReadInputTokens: 100,
      cacheCreationInputTokens: 0,
    });
  });

  it("uses processedAt for billing-period membership", async () => {
    mockClerkUserLookup();
    const periodEnd = new Date("2099-04-01T00:00:00.000Z");
    const periodStart = new Date("2099-03-01T00:00:00.000Z");
    const fixture = await track(
      store.set(
        seedUsageFixture$,
        { currentPeriodEnd: periodEnd, tier: "pro" },
        context.signal,
      ),
    );
    await store.set(
      insertModelUsage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
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
        orgId: fixture.orgId,
        userId: fixture.userId,
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
        orgId: fixture.orgId,
        userId: fixture.userId,
        kind: "model",
        provider: "claude-sonnet-4-6",
        category: "tokens.input",
        quantity: 999,
        creditsCharged: 999,
        processedAt: periodEnd,
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().get({ headers: authHeaders() }),
      [200],
    );

    expect(response.body.members).toHaveLength(1);
    expect(response.body.members[0]).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      creditsCharged: 10,
    });
  });
});
