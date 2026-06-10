import { randomUUID } from "node:crypto";

import { pushSubscriptionsContract } from "@vm0/api-contracts/contracts/push-subscriptions";
import { pushSubscriptions } from "@vm0/db/schema/push-subscription";
import { createStore } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { clearMockNow, mockNow } from "../../../lib/time";
import { writeDb$ } from "../../external/db";
import { clearPushSubscriptionsForUser$ } from "./helpers/zero-push-subscriptions";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function validBody(
  endpoint = "https://fcm.googleapis.com/fcm/send/test-endpoint-123",
) {
  return {
    endpoint,
    keys: {
      p256dh:
        "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8p8REfXRI",
      auth: "tBHItJI5svbpC7hYyKw",
    },
  };
}

function pushSubscriptionRows(userId: string) {
  const db = store.set(writeDb$);
  return db
    .select({
      userId: pushSubscriptions.userId,
      endpoint: pushSubscriptions.endpoint,
      p256dh: pushSubscriptions.p256dh,
      auth: pushSubscriptions.auth,
      createdAt: pushSubscriptions.createdAt,
    })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId))
    .orderBy(pushSubscriptions.endpoint);
}

describe("POST /api/zero/push-subscriptions", () => {
  const createdUserIds: string[] = [];

  afterEach(async () => {
    clearMockNow();
    while (createdUserIds.length > 0) {
      const userId = createdUserIds.pop();
      if (userId) {
        await store.set(clearPushSubscriptionsForUser$, userId, context.signal);
      }
    }
  });

  it("returns 401 when unauthenticated", async () => {
    const client = setupApp({ context })(pushSubscriptionsContract);
    const response = await accept(
      client.register({ body: validBody(), headers: {} }),
      [401],
    );
    expect(response.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });

  it("registers a push subscription and returns 201 success", async () => {
    const userId = `user_${randomUUID().slice(0, 8)}`;
    createdUserIds.push(userId);
    mocks.clerk.session(userId, null);
    const body = validBody(
      `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
    );

    const client = setupApp({ context })(pushSubscriptionsContract);
    const response = await accept(
      client.register({
        body,
        headers: { authorization: "Bearer clerk-session" },
      }),
      [201],
    );

    expect(response.body).toStrictEqual({ success: true });

    const rows = await pushSubscriptionRows(userId);
    expect(rows).toMatchObject([
      {
        userId,
        endpoint: body.endpoint,
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
      },
    ]);
    expect(rows[0]?.createdAt).toBeInstanceOf(Date);
  });

  it("upserts on same endpoint", async () => {
    const userId = `user_${randomUUID().slice(0, 8)}`;
    createdUserIds.push(userId);
    mocks.clerk.session(userId, null);
    const endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;

    const client = setupApp({ context })(pushSubscriptionsContract);
    const first = await accept(
      client.register({
        body: validBody(endpoint),
        headers: { authorization: "Bearer clerk-session" },
      }),
      [201],
    );
    expect(first.body).toStrictEqual({ success: true });

    const second = await accept(
      client.register({
        body: {
          ...validBody(endpoint),
          keys: { p256dh: "updated-p256dh-key", auth: "updated-auth-key" },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [201],
    );
    expect(second.body).toStrictEqual({ success: true });

    const rows = await pushSubscriptionRows(userId);
    expect(rows).toMatchObject([
      {
        userId,
        endpoint,
        p256dh: "updated-p256dh-key",
        auth: "updated-auth-key",
      },
    ]);
    expect(rows).toHaveLength(1);
  });

  it("cleans up stale subscriptions for the current user", async () => {
    const userId = `user_${randomUUID().slice(0, 8)}`;
    createdUserIds.push(userId);
    mocks.clerk.session(userId, null);
    mockNow(new Date("2026-05-16T00:00:00.000Z"));
    const staleEndpoint = `https://fcm.googleapis.com/fcm/send/stale-${randomUUID()}`;
    const freshEndpoint = `https://fcm.googleapis.com/fcm/send/fresh-${randomUUID()}`;
    const newEndpoint = `https://fcm.googleapis.com/fcm/send/new-${randomUUID()}`;
    const db = store.set(writeDb$);
    await db.insert(pushSubscriptions).values([
      {
        userId,
        endpoint: staleEndpoint,
        p256dh: "stale-p256dh",
        auth: "stale-auth",
        createdAt: new Date("2026-05-08T23:59:59.000Z"),
      },
      {
        userId,
        endpoint: freshEndpoint,
        p256dh: "fresh-p256dh",
        auth: "fresh-auth",
        createdAt: new Date("2026-05-15T00:00:00.000Z"),
      },
    ]);

    const client = setupApp({ context })(pushSubscriptionsContract);
    const response = await accept(
      client.register({
        body: validBody(newEndpoint),
        headers: { authorization: "Bearer clerk-session" },
      }),
      [201],
    );

    expect(response.body).toStrictEqual({ success: true });
    const rows = await db
      .select({ endpoint: pushSubscriptions.endpoint })
      .from(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.userId, userId),
          inArray(pushSubscriptions.endpoint, [
            staleEndpoint,
            freshEndpoint,
            newEndpoint,
          ]),
        ),
      )
      .orderBy(pushSubscriptions.endpoint);
    expect(rows).toStrictEqual([
      { endpoint: freshEndpoint },
      { endpoint: newEndpoint },
    ]);
  });

  it("returns 400 for invalid body", async () => {
    const userId = `user_${randomUUID().slice(0, 8)}`;
    mocks.clerk.session(userId, null);

    const client = setupApp({ context })(pushSubscriptionsContract);
    const response = await accept(
      client.register({
        body: {
          endpoint: "not-a-url",
          keys: { p256dh: "", auth: "" },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body.error).toBeDefined();
  });
});
