import { randomUUID } from "node:crypto";

import { platformRealtimeTokenContract } from "@vm0/api-contracts/contracts/realtime";
import { beforeEach, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

// BDD migration of the legacy `zero-realtime-token.test.ts`. The Given is
// a Clerk session + an Ably token-request mock — both external services —
// so no DB writes are needed. The legacy 2 `it()`s collapse into one
// GWT-WT-WT chain sharing the Ably mock; auth-boundary stays separate.

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

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function client() {
  return setupApp({ context })(platformRealtimeTokenContract);
}

describe("BDD POST /api/zero/realtime/token — auth boundary", () => {
  it("returns 401 when unauthenticated and does not call Ably", async () => {
    const response = await accept(
      client().create({ body: {}, headers: {} }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Authentication required", code: "UNAUTHORIZED" },
    });
    expect(context.mocks.ably.createTokenRequest).not.toHaveBeenCalled();
  });
});

describe("BDD POST /api/zero/realtime/token — token issuance chain", () => {
  beforeEach(() => {
    context.mocks.ably.createTokenRequest.mockResolvedValue(tokenRequest);
  });

  it("gwt-wt-wt: returns a subscribe-only Ably token for the user channel", async () => {
    // Given: an authenticated Clerk session for a fresh user.
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);
    const c = client();

    // When + Then: the response echoes the Ably token request.
    const response = await accept(
      c.create({ body: {}, headers: authHeaders() }),
      [200],
    );
    expect(response.body).toStrictEqual(tokenRequest);

    // And: Ably was called with a user-scoped subscribe capability, the
    // 1-hour TTL, and the authenticated user as the clientId.
    expect(context.mocks.ably.createTokenRequest).toHaveBeenCalledWith({
      capability: {
        [`user:${userId}`]: ["subscribe"],
      },
      ttl: 3_600_000,
      clientId: userId,
    });
  });
});
