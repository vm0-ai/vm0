import { zeroVariablesContract } from "@vm0/api-contracts/contracts/zero-secrets";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockApiShadowCompareRoutes } from "../../context/shadow-compare";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteUserData$,
  seedOtherVariable$,
  seedVariables$,
  type UserDataFixture,
} from "./helpers/zero-user-data";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

describe("GET /api/zero/variables", () => {
  const track = createFixtureTracker<UserDataFixture>((fixture) => {
    return store.set(deleteUserData$, fixture, context.signal);
  });

  it("returns current user variables sorted by name", async () => {
    const createdAt = new Date("2026-02-02T03:04:05.000Z");
    const updatedAt = new Date("2026-02-03T03:04:05.000Z");
    const fixture = await track(
      store.set(
        seedVariables$,
        [
          {
            name: "Z_REGION",
            value: "us-west-2",
            description: null,
            createdAt,
            updatedAt,
          },
          {
            name: "A_ENDPOINT",
            value: "https://api.example.test",
            description: "endpoint",
            createdAt,
            updatedAt,
          },
        ],
        context.signal,
      ),
    );
    await store.set(seedOtherVariable$, fixture, context.signal);
    mocks.clerk.session(fixture.userId, fixture.orgId);
    mockApiShadowCompareRoutes([zeroVariablesContract.list]);

    const client = setupApp({ context })(zeroVariablesContract);

    const response = await accept(
      client.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.variables).toHaveLength(2);
    expect(response.body.variables).toMatchObject([
      {
        name: "A_ENDPOINT",
        value: "https://api.example.test",
        description: "endpoint",
        createdAt: "2026-02-02T03:04:05.000Z",
        updatedAt: "2026-02-03T03:04:05.000Z",
      },
      {
        name: "Z_REGION",
        value: "us-west-2",
        description: null,
        createdAt: "2026-02-02T03:04:05.000Z",
        updatedAt: "2026-02-03T03:04:05.000Z",
      },
    ]);
  });

  it("returns an empty list when the user has no variables", async () => {
    const fixture = await track(store.set(seedVariables$, [], context.signal));
    mocks.clerk.session(fixture.userId, fixture.orgId);
    mockApiShadowCompareRoutes([zeroVariablesContract.list]);

    const client = setupApp({ context })(zeroVariablesContract);

    const response = await accept(
      client.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ variables: [] });
  });
});
