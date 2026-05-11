import { randomUUID } from "node:crypto";

import { zeroSecretsContract } from "@vm0/api-contracts/contracts/zero-secrets";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteUserData$,
  seedOtherSecret$,
  seedSecrets$,
  type UserDataFixture,
} from "./helpers/zero-user-data";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

describe("GET /api/zero/secrets", () => {
  const track = createFixtureTracker<UserDataFixture>((fixture) => {
    return store.set(deleteUserData$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(zeroSecretsContract);

    const response = await accept(client.list({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({ context })(zeroSecretsContract);

    const response = await accept(
      client.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns current user secret metadata sorted by name", async () => {
    const createdAt = new Date("2026-01-02T03:04:05.000Z");
    const updatedAt = new Date("2026-01-03T03:04:05.000Z");
    const fixture = await track(
      store.set(
        seedSecrets$,
        [
          {
            name: "Z_TOKEN",
            description: null,
            type: "connector",
            createdAt,
            updatedAt,
          },
          {
            name: "A_TOKEN",
            description: "alpha",
            type: "user",
            createdAt,
            updatedAt,
          },
        ],
        context.signal,
      ),
    );
    await store.set(seedOtherSecret$, fixture, context.signal);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroSecretsContract);

    const response = await accept(
      client.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.secrets).toHaveLength(2);
    expect(response.body.secrets).toMatchObject([
      {
        name: "A_TOKEN",
        description: "alpha",
        type: "user",
        createdAt: "2026-01-02T03:04:05.000Z",
        updatedAt: "2026-01-03T03:04:05.000Z",
      },
      {
        name: "Z_TOKEN",
        description: null,
        type: "connector",
        createdAt: "2026-01-02T03:04:05.000Z",
        updatedAt: "2026-01-03T03:04:05.000Z",
      },
    ]);
    for (const secret of response.body.secrets) {
      expect(secret).not.toHaveProperty("value");
      expect(secret).not.toHaveProperty("encryptedValue");
    }
  });

  it("returns an empty list when the user has no secrets", async () => {
    const fixture = await track(store.set(seedSecrets$, [], context.signal));
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroSecretsContract);

    const response = await accept(
      client.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ secrets: [] });
  });
});
