import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

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

interface PushSubscriptionBody {
  readonly endpoint: string;
  readonly keys: {
    readonly p256dh: string;
    readonly auth: string;
  };
}

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function client() {
  return setupApp({ context })(pushSubscriptionsContract);
}

function testUserId(prefix: string): string {
  return `user_${prefix}_${randomUUID().slice(0, 8)}`;
}

function endpoint(prefix: string): string {
  return `https://fcm.googleapis.com/fcm/send/${prefix}-${randomUUID()}`;
}

function validBody(prefix: string): PushSubscriptionBody {
  return {
    endpoint: endpoint(prefix),
    keys: {
      p256dh:
        "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8p8REfXRI",
      auth: "tBHItJI5svbpC7hYyKw",
    },
  };
}

function mockUser(userId: string): void {
  mocks.clerk.session(userId, null);
}

async function subscriptionRows(userId: string) {
  return await store
    .set(writeDb$)
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

describe("POST /api/zero/push-subscriptions helper gaps", () => {
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

  it("persists route-created subscription metadata", async () => {
    const userId = testUserId("push_persist");
    createdUserIds.push(userId);
    mockUser(userId);
    const body = validBody("persist");

    const response = await accept(
      client().register({
        body,
        headers: authHeaders(),
      }),
      [201],
    );

    expect(response.body).toStrictEqual({ success: true });

    const rows = await subscriptionRows(userId);
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

  it("updates an existing endpoint without adding a duplicate row", async () => {
    const userId = testUserId("push_upsert");
    createdUserIds.push(userId);
    mockUser(userId);
    const body = validBody("upsert");

    const firstRegistration = await accept(
      client().register({
        body,
        headers: authHeaders(),
      }),
      [201],
    );
    expect(firstRegistration.body).toStrictEqual({ success: true });

    const secondRegistration = await accept(
      client().register({
        body: {
          ...body,
          keys: {
            p256dh: "updated-p256dh-key",
            auth: "updated-auth-key",
          },
        },
        headers: authHeaders(),
      }),
      [201],
    );
    expect(secondRegistration.body).toStrictEqual({ success: true });

    const rows = await subscriptionRows(userId);
    expect(rows).toMatchObject([
      {
        userId,
        endpoint: body.endpoint,
        p256dh: "updated-p256dh-key",
        auth: "updated-auth-key",
      },
    ]);
    expect(rows).toHaveLength(1);
  });

  it("cleans up stale subscriptions for the current user", async () => {
    const userId = testUserId("push_stale");
    createdUserIds.push(userId);
    mockUser(userId);
    mockNow(new Date("2026-05-16T00:00:00.000Z"));
    const staleEndpoint = endpoint("stale");
    const freshEndpoint = endpoint("fresh");
    const newEndpoint = endpoint("new");
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

    const response = await accept(
      client().register({
        body: {
          ...validBody("fresh-register"),
          endpoint: newEndpoint,
        },
        headers: authHeaders(),
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
});
