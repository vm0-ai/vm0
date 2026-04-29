import { apiKeysContract } from "@vm0/api-contracts/contracts/api-keys";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockApiShadowCompareRoutes } from "../../context/shadow-compare";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteApiKeys,
  seedApiKeys,
  type ApiKeysFixture,
} from "./helpers/zero-api-keys";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

describe("GET /api/zero/api-keys", () => {
  const track = createFixtureTracker<ApiKeysFixture>((fixture) => {
    return deleteApiKeys(store, fixture);
  });

  it("returns the current user's API keys sorted by creation time", async () => {
    const fixture = await track(
      seedApiKeys(store, [
        {
          name: "Older",
          token: "vm0_pat_older_token",
          createdAt: new Date("2026-03-01T00:00:00.000Z"),
          expiresAt: new Date("2026-04-01T00:00:00.000Z"),
        },
        {
          name: "Newer",
          token: "vm0_pat_newer_token",
          createdAt: new Date("2026-03-02T00:00:00.000Z"),
          expiresAt: new Date("2026-04-02T00:00:00.000Z"),
          lastUsedAt: new Date("2026-03-03T00:00:00.000Z"),
        },
      ]),
    );
    await track(
      seedApiKeys(store, [
        {
          name: "Other user",
          token: "vm0_pat_other_token",
          createdAt: new Date("2026-03-03T00:00:00.000Z"),
          expiresAt: new Date("2026-04-03T00:00:00.000Z"),
        },
      ]),
    );
    mocks.clerk.session(fixture.userId, null);
    mockApiShadowCompareRoutes([apiKeysContract.list]);

    const client = setupApp({ context })(apiKeysContract);

    const response = await accept(
      client.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.apiKeys).toHaveLength(2);
    expect(response.body.apiKeys).toMatchObject([
      {
        name: "Newer",
        tokenPrefix: "vm0_pat_newe\u2026",
        createdAt: "2026-03-02T00:00:00.000Z",
        expiresAt: "2026-04-02T00:00:00.000Z",
        lastUsedAt: "2026-03-03T00:00:00.000Z",
      },
      {
        name: "Older",
        tokenPrefix: "vm0_pat_olde\u2026",
        createdAt: "2026-03-01T00:00:00.000Z",
        expiresAt: "2026-04-01T00:00:00.000Z",
        lastUsedAt: null,
      },
    ]);
  });

  it("returns an empty list when the user has no API keys", async () => {
    const fixture = await track(seedApiKeys(store, []));
    mocks.clerk.session(fixture.userId, null);
    mockApiShadowCompareRoutes([apiKeysContract.list]);

    const client = setupApp({ context })(apiKeysContract);

    const response = await accept(
      client.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ apiKeys: [] });
  });
});
