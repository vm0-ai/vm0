import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the realtime token endpoint. Ably mints the token,
// so its token request is the external dependency we stub; the subscribe-only
// capability scoped to the caller's own channel is only observable through the
// Ably mock (there is no read-back API). See `api.bdd.md` (CHAIN-REALTIME-TOKEN).
const context = testContext();

const TOKEN_REQUEST = Object.freeze({
  keyName: "test-key",
  timestamp: 1_700_000_000_000,
  capability: '{"user:test-user":["subscribe"]}',
  clientId: "test-user",
  nonce: "test-nonce",
  mac: "test-mac",
});

describe("realtime token (API-first BDD)", () => {
  it("mints a subscribe-only Ably token for the caller's own channel", async () => {
    const api = createBddApi(context);
    const actor = api.actAsAdmin();
    context.mocks.ably.createTokenRequest.mockResolvedValue(TOKEN_REQUEST);

    const response = await accept(
      api.realtimeToken.create({ headers: SESSION_AUTH, body: {} }),
      [200],
    );

    // Then the Ably token request is returned and scoped to the caller's
    // subscribe-only user channel.
    expect(response.body).toStrictEqual(TOKEN_REQUEST);
    expect(context.mocks.ably.createTokenRequest).toHaveBeenCalledWith({
      capability: { [`user:${actor.userId}`]: ["subscribe"] },
      ttl: 3_600_000,
      clientId: actor.userId,
    });
  });

  it("returns 401 and mints nothing when unauthenticated", async () => {
    const api = createBddApi(context);
    context.mocks.ably.createTokenRequest.mockResolvedValue(TOKEN_REQUEST);

    const response = await accept(
      api.realtimeToken.create({ headers: {}, body: {} }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Authentication required", code: "UNAUTHORIZED" },
    });
    expect(context.mocks.ably.createTokenRequest).not.toHaveBeenCalled();
  });
});
