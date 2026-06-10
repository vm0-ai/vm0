import { apiKeysContract } from "@vm0/api-contracts/contracts/api-keys";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  deleteApiKeys$,
  seedApiKeys$,
  type ApiKeysFixture,
} from "./helpers/zero-api-keys";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

// The API-key create/list/delete CRUD and validation cases have migrated to
// `zero-api-keys.bdd.test.ts` (API-first BDD). This file retains only the case
// that needs controlled timestamps and a non-null `lastUsedAt` — neither is
// expressible through the public API (GAP-APIKEY-TIMESTAMPS in `api.bdd.md`).
const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

describe("GET /api/zero/api-keys", () => {
  const track = createFixtureTracker<ApiKeysFixture>((fixture) => {
    return store.set(deleteApiKeys$, fixture, context.signal);
  });

  it("returns the current user's API keys sorted by creation time", async () => {
    const fixture = await track(
      store.set(
        seedApiKeys$,
        [
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
        ],
        context.signal,
      ),
    );
    await track(
      store.set(
        seedApiKeys$,
        [
          {
            name: "Other user",
            token: "vm0_pat_other_token",
            createdAt: new Date("2026-03-03T00:00:00.000Z"),
            expiresAt: new Date("2026-04-03T00:00:00.000Z"),
          },
        ],
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, null);

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
        tokenPrefix: "vm0_pat_newe…",
        createdAt: "2026-03-02T00:00:00.000Z",
        expiresAt: "2026-04-02T00:00:00.000Z",
        lastUsedAt: "2026-03-03T00:00:00.000Z",
      },
      {
        name: "Older",
        tokenPrefix: "vm0_pat_olde…",
        createdAt: "2026-03-01T00:00:00.000Z",
        expiresAt: "2026-04-01T00:00:00.000Z",
        lastUsedAt: null,
      },
    ]);
  });
});
