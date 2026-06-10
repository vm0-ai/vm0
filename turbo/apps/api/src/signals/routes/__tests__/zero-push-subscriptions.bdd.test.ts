import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { pushSubscriptionsContract } from "@vm0/api-contracts/contracts/push-subscriptions";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
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

function validBody(prefix: string): PushSubscriptionBody {
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/${prefix}-${randomUUID()}`,
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

describe("POST /api/zero/push-subscriptions BDD", () => {
  it("rejects unauthenticated and malformed registration requests", async () => {
    const api = client();

    const unauthenticated = await accept(
      api.register({ body: validBody("unauthenticated"), headers: {} }),
      [401],
    );

    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    mockUser(testUserId("push_invalid"));
    const invalidBody = await accept(
      api.register({
        body: {
          endpoint: "not-a-url",
          keys: { p256dh: "", auth: "" },
        },
        headers: authHeaders(),
      }),
      [400],
    );

    expect(invalidBody.body.error.code).toBe("BAD_REQUEST");
  });

  it("registers a subscription for an authenticated user without an active org", async () => {
    mockUser(testUserId("push_register"));

    const response = await accept(
      client().register({
        body: validBody("register"),
        headers: authHeaders(),
      }),
      [201],
    );

    expect(response.body).toStrictEqual({ success: true });
  });

  it("accepts repeated registration for the same endpoint", async () => {
    mockUser(testUserId("push_reregister"));
    const body = validBody("reregister");

    const firstRegistration = await accept(
      client().register({
        body,
        headers: authHeaders(),
      }),
      [201],
    );

    expect(firstRegistration.body).toStrictEqual({ success: true });

    const repeatedRegistration = await accept(
      client().register({
        body: {
          ...body,
          keys: {
            p256dh: `updated-p256dh-${randomUUID()}`,
            auth: `updated-auth-${randomUUID()}`,
          },
        },
        headers: authHeaders(),
      }),
      [201],
    );

    expect(repeatedRegistration.body).toStrictEqual({ success: true });
  });
});
