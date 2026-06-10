import { randomUUID } from "node:crypto";

import { platformRealtimeTokenContract } from "@vm0/api-contracts/contracts/realtime";
import { describe, expect, it, beforeEach } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

const tokenRequest = Object.freeze({
  keyName: "test-key",
  timestamp: 1_700_000_000_000,
  capability: '{"user:test-user":["subscribe"]}',
  clientId: "test-user",
  nonce: "test-nonce",
  mac: "test-mac",
});

describe("POST /api/zero/realtime/token BDD", () => {
  beforeEach(() => {
    context.mocks.ably.createTokenRequest.mockResolvedValue(tokenRequest);
  });

  it("rejects unauthenticated requests before issuing a user token", async () => {
    const client = setupApp({ context })(platformRealtimeTokenContract);

    const unauthenticated = await accept(
      client.create({ body: {}, headers: {} }),
      [401],
    );

    expect(unauthenticated.body).toStrictEqual({
      error: {
        message: "Authentication required",
        code: "UNAUTHORIZED",
      },
    });
    expect(context.mocks.ably.createTokenRequest).not.toHaveBeenCalled();

    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const authenticated = await accept(
      client.create({
        body: {},
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(authenticated.body).toStrictEqual(tokenRequest);
    expect(context.mocks.ably.createTokenRequest).toHaveBeenCalledWith({
      capability: {
        [`user:${userId}`]: ["subscribe"],
      },
      ttl: 3_600_000,
      clientId: userId,
    });
  });
});
