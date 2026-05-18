import { randomUUID } from "node:crypto";

import { zeroMemberCreditCapContract } from "@vm0/api-contracts/contracts/zero-member-credit-cap";
import { createStore } from "ccstate";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { and, eq } from "drizzle-orm";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import { now } from "../../external/time";
import {
  deleteMemberCreditCapFixture$,
  insertProcessedConnectorUsage$,
  insertProcessedModelUsage$,
  seedMemberCreditCapFixture$,
  type MemberCreditCapFixture,
} from "./helpers/zero-member-credit-cap";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function apiClient() {
  return setupApp({ context })(zeroMemberCreditCapContract);
}

describe("GET /api/zero/org/members/credit-cap", () => {
  it("returns 401 for unauthenticated request", async () => {
    const userId = `user_${randomUUID()}`;
    const response = await accept(
      apiClient().get({ query: { userId }, headers: {} }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    const sessionUserId = `user_${randomUUID()}`;
    const targetUserId = `user_${randomUUID()}`;
    mocks.clerk.session(sessionUserId, null);

    const response = await accept(
      apiClient().get({
        query: { userId: targetUserId },
        headers: authHeaders(),
      }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns default cap state (null cap, enabled)", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const response = await accept(
      apiClient().get({ query: { userId }, headers: authHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({
      userId,
      creditCap: null,
      creditEnabled: true,
    });
  });

  it("returns 400 when userId is missing", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const response = await accept(
      apiClient().get({ query: { userId: "" }, headers: authHeaders() }),
      [400],
    );
    expect(response.body.error.code).toBe("BAD_REQUEST");
  });
});

describe("PUT /api/zero/org/members/credit-cap", () => {
  const track = createFixtureTracker<MemberCreditCapFixture>((fixture) => {
    return store.set(deleteMemberCreditCapFixture$, fixture, context.signal);
  });

  it("returns 401 for unauthenticated request", async () => {
    const userId = `user_${randomUUID()}`;

    const response = await accept(
      apiClient().set({
        body: { userId, creditCap: 5000 },
        headers: {},
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    const sessionUserId = `user_${randomUUID()}`;
    const targetUserId = `user_${randomUUID()}`;
    mocks.clerk.session(sessionUserId, null);

    const response = await accept(
      apiClient().set({
        body: { userId: targetUserId, creditCap: 5000 },
        headers: authHeaders(),
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("sets credit cap as admin", async () => {
    const fixture = await track(
      store.set(seedMemberCreditCapFixture$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().set({
        body: { userId: fixture.userId, creditCap: 5000 },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      userId: fixture.userId,
      creditCap: 5000,
      creditEnabled: true,
    });

    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({
        creditCap: orgMembersMetadata.creditCap,
        creditEnabled: orgMembersMetadata.creditEnabled,
      })
      .from(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, fixture.orgId),
          eq(orgMembersMetadata.userId, fixture.userId),
        ),
      );
    expect(row?.creditCap).toBe(5000);
    expect(row?.creditEnabled).toBeTruthy();
  });

  it("disables member when cap is below current usage", async () => {
    const periodEnd = new Date(now() + 15 * 24 * 60 * 60 * 1000);
    const fixture = await track(
      store.set(
        seedMemberCreditCapFixture$,
        { currentPeriodEnd: periodEnd },
        context.signal,
      ),
    );
    await store.set(
      insertProcessedModelUsage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        creditsCharged: 200,
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().set({
        body: { userId: fixture.userId, creditCap: 100 },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      userId: fixture.userId,
      creditCap: 100,
      creditEnabled: false,
    });
  });

  it("disables member when usage_event spend exceeds cap", async () => {
    const periodEnd = new Date(now() + 15 * 24 * 60 * 60 * 1000);
    const fixture = await track(
      store.set(
        seedMemberCreditCapFixture$,
        { currentPeriodEnd: periodEnd },
        context.signal,
      ),
    );
    await store.set(
      insertProcessedModelUsage$,
      { orgId: fixture.orgId, userId: fixture.userId, creditsCharged: 80 },
      context.signal,
    );
    await store.set(
      insertProcessedConnectorUsage$,
      { orgId: fixture.orgId, userId: fixture.userId, creditsCharged: 40 },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().set({
        body: { userId: fixture.userId, creditCap: 100 },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      userId: fixture.userId,
      creditCap: 100,
      creditEnabled: false,
    });
  });

  it("disables member when usage_event spend exactly reaches cap", async () => {
    const periodEnd = new Date(now() + 15 * 24 * 60 * 60 * 1000);
    const fixture = await track(
      store.set(
        seedMemberCreditCapFixture$,
        { currentPeriodEnd: periodEnd },
        context.signal,
      ),
    );
    await store.set(
      insertProcessedModelUsage$,
      { orgId: fixture.orgId, userId: fixture.userId, creditsCharged: 60 },
      context.signal,
    );
    await store.set(
      insertProcessedConnectorUsage$,
      { orgId: fixture.orgId, userId: fixture.userId, creditsCharged: 40 },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().set({
        body: { userId: fixture.userId, creditCap: 100 },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      userId: fixture.userId,
      creditCap: 100,
      creditEnabled: false,
    });
  });

  it("ignores processed usage at the billing period end boundary", async () => {
    const periodEnd = new Date("2099-04-01T00:00:00Z");
    const fixture = await track(
      store.set(
        seedMemberCreditCapFixture$,
        { currentPeriodEnd: periodEnd },
        context.signal,
      ),
    );
    await store.set(
      insertProcessedModelUsage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        creditsCharged: 40,
        processedAt: new Date("2099-03-15T00:00:00Z"),
      },
      context.signal,
    );
    await store.set(
      insertProcessedConnectorUsage$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        creditsCharged: 80,
        processedAt: periodEnd,
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().set({
        body: { userId: fixture.userId, creditCap: 100 },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      userId: fixture.userId,
      creditCap: 100,
      creditEnabled: true,
    });
  });

  it("re-enables member when cap is raised above usage", async () => {
    const periodEnd = new Date(now() + 15 * 24 * 60 * 60 * 1000);
    const fixture = await track(
      store.set(
        seedMemberCreditCapFixture$,
        { currentPeriodEnd: periodEnd },
        context.signal,
      ),
    );
    await store.set(
      insertProcessedModelUsage$,
      { orgId: fixture.orgId, userId: fixture.userId, creditsCharged: 200 },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const r1 = await accept(
      apiClient().set({
        body: { userId: fixture.userId, creditCap: 100 },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(r1.body.creditEnabled).toBeFalsy();

    const r2 = await accept(
      apiClient().set({
        body: { userId: fixture.userId, creditCap: 500 },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(r2.body).toStrictEqual({
      userId: fixture.userId,
      creditCap: 500,
      creditEnabled: true,
    });
  });

  it("removes cap and re-enables with null", async () => {
    const fixture = await track(
      store.set(
        seedMemberCreditCapFixture$,
        { creditCap: 100, creditEnabled: false },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().set({
        body: { userId: fixture.userId, creditCap: null },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      userId: fixture.userId,
      creditCap: null,
      creditEnabled: true,
    });
  });

  it("returns 403 for non-admin", async () => {
    const fixture = await track(
      store.set(seedMemberCreditCapFixture$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const response = await accept(
      apiClient().set({
        body: { userId: fixture.userId, creditCap: 5000 },
        headers: authHeaders(),
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Only org admins can update member credit caps",
        code: "FORBIDDEN",
      },
    });
  });

  it("returns 400 for invalid body", async () => {
    const fixture = await track(
      store.set(seedMemberCreditCapFixture$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      apiClient().set({
        body: { creditCap: 5000 } as unknown as {
          userId: string;
          creditCap: number | null;
        },
        headers: authHeaders(),
      }),
      [400],
    );
    expect(response.body.error.code).toBe("BAD_REQUEST");
  });
});
