import { randomUUID } from "node:crypto";

import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockApiShadowCompareRoutes } from "../../context/shadow-compare";
import {
  deleteFeatureSwitches,
  seedFeatureSwitches,
  type FeatureSwitchesFixture,
} from "./helpers/zero-feature-switches";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

describe("GET /api/zero/feature-switches", () => {
  const track = createFixtureTracker<FeatureSwitchesFixture>((fixture) => {
    return deleteFeatureSwitches(store, fixture);
  });

  it("returns persisted feature switch overrides", async () => {
    const fixture = await track(
      seedFeatureSwitches(store, {
        apiBackend: true,
        audioInput: false,
      }),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    mockApiShadowCompareRoutes([zeroFeatureSwitchesContract.get]);

    const client = setupApp({ context })(zeroFeatureSwitchesContract);

    const response = await accept(
      client.get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      switches: {
        apiBackend: true,
        audioInput: false,
      },
    });
  });

  it("returns empty switches when no override row exists", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);
    mockApiShadowCompareRoutes([zeroFeatureSwitchesContract.get]);

    const client = setupApp({ context })(zeroFeatureSwitchesContract);

    const response = await accept(
      client.get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ switches: {} });
  });
});
