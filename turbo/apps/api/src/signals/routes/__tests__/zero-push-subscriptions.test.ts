import { randomUUID } from "node:crypto";

import { pushSubscriptionsContract } from "@vm0/api-contracts/contracts/push-subscriptions";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { clearPushSubscriptionsForUser$ } from "./helpers/zero-push-subscriptions";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function validBody() {
  return {
    endpoint: "https://fcm.googleapis.com/fcm/send/test-endpoint-123",
    keys: {
      p256dh:
        "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8p8REfXRI",
      auth: "tBHItJI5svbpC7hYyKw",
    },
  };
}

describe("POST /api/zero/push-subscriptions", () => {
  const createdUserIds: string[] = [];

  afterEach(async () => {
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

    const client = setupApp({ context })(pushSubscriptionsContract);
    const response = await accept(
      client.register({
        body: validBody(),
        headers: { authorization: "Bearer clerk-session" },
      }),
      [201],
    );

    expect(response.body).toStrictEqual({ success: true });
  });

  it("upserts on same endpoint", async () => {
    const userId = `user_${randomUUID().slice(0, 8)}`;
    createdUserIds.push(userId);
    mocks.clerk.session(userId, null);

    const client = setupApp({ context })(pushSubscriptionsContract);
    const first = await accept(
      client.register({
        body: validBody(),
        headers: { authorization: "Bearer clerk-session" },
      }),
      [201],
    );
    expect(first.body).toStrictEqual({ success: true });

    const second = await accept(
      client.register({
        body: {
          ...validBody(),
          keys: { p256dh: "updated-p256dh-key", auth: "updated-auth-key" },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [201],
    );
    expect(second.body).toStrictEqual({ success: true });
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
