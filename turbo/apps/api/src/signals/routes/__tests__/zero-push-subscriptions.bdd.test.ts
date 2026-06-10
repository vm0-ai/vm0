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

// BDD migration of the legacy `zero-push-subscriptions.test.ts`.
// The 5 legacy `it()`s collapse into 2 BDD `it()`s: (1) 401
// unauth + 400 invalid body chain, (2) 201 register +
// upsert + stale cleanup chain (verifies the row state via
// direct DB reads — Service-Level Exception since
// `push-subscriptions` has no public GET/list API).
//
// Service-Level Exception: the route only exposes
// `POST /api/zero/push-subscriptions`; there is no
// follow-up read endpoint. Verifying row state therefore
// requires direct DB reads against the `push_subscriptions`
// table. This is the only verification path the test
// suite has for this resource.

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function client() {
  return setupApp({ context })(pushSubscriptionsContract);
}

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

describe("BDD POST /api/zero/push-subscriptions — auth + validation", () => {
  afterEach(() => {
    clearMockNow();
  });

  it("gwt-wt-wt: 401 no auth → 400 invalid body when authenticated", async () => {
    const c = client();

    // When + Then: 401 with no auth header.
    const noAuth = await accept(
      c.register({ body: validBody(), headers: {} }),
      [401],
    );
    expect(noAuth.body).toMatchObject({ error: { code: "UNAUTHORIZED" } });

    // Given: an authenticated session.
    const userId = `user_${randomUUID().slice(0, 8)}`;
    mocks.clerk.session(userId, null);

    // When + Then: 400 invalid body.
    const invalid = await accept(
      c.register({
        body: { endpoint: "not-a-url", keys: { p256dh: "", auth: "" } },
        headers: authHeaders(),
      }),
      [400],
    );
    expect(invalid.body.error).toBeDefined();

    // Cleanup.
    await store.set(clearPushSubscriptionsForUser$, userId, context.signal);
  });
});

describe("BDD POST /api/zero/push-subscriptions — 201 register + upsert + stale cleanup", () => {
  afterEach(() => {
    clearMockNow();
  });

  it("gwt-wt-wt: 201 first register → 201 upsert on same endpoint → 201 register wipes stale subscriptions older than 7 days", async () => {
    const userId = `user_${randomUUID().slice(0, 8)}`;
    mocks.clerk.session(userId, null);
    const c = client();

    // When + Then: 201 on first register.
    const endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;
    const first = await accept(
      c.register({ body: validBody(endpoint), headers: authHeaders() }),
      [201],
    );
    expect(first.body).toStrictEqual({ success: true });

    // Then: a row exists with the registered endpoint +
    // keys + a `createdAt` timestamp.
    const initialRows = await pushSubscriptionRows(userId);
    expect(initialRows).toMatchObject([
      {
        userId,
        endpoint,
        p256dh: validBody(endpoint).keys.p256dh,
        auth: validBody(endpoint).keys.auth,
      },
    ]);
    expect(initialRows[0]?.createdAt).toBeInstanceOf(Date);

    // When + Then: 201 upsert with the same endpoint but
    // new keys.
    const second = await accept(
      c.register({
        body: {
          ...validBody(endpoint),
          keys: { p256dh: "updated-p256dh-key", auth: "updated-auth-key" },
        },
        headers: authHeaders(),
      }),
      [201],
    );
    expect(second.body).toStrictEqual({ success: true });

    // Then: the same row is updated (not duplicated) and
    // now holds the new keys.
    const updatedRows = await pushSubscriptionRows(userId);
    expect(updatedRows).toMatchObject([
      {
        userId,
        endpoint,
        p256dh: "updated-p256dh-key",
        auth: "updated-auth-key",
      },
    ]);
    expect(updatedRows).toHaveLength(1);

    // Given: two pre-existing rows for the same user — a
    // 7-day-old `stale` row and a recent `fresh` row.
    // Mock the clock to a known instant so the 7-day
    // cutoff is deterministic.
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

    // When: register a brand-new endpoint.
    const cleanup = await accept(
      c.register({ body: validBody(newEndpoint), headers: authHeaders() }),
      [201],
    );
    expect(cleanup.body).toStrictEqual({ success: true });

    // Then: the stale row is gone; the fresh + new rows
    // remain.
    const remaining = await db
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
    expect(remaining).toStrictEqual([
      { endpoint: freshEndpoint },
      { endpoint: newEndpoint },
    ]);

    // Cleanup.
    await store.set(clearPushSubscriptionsForUser$, userId, context.signal);
  });
});
