import { randomUUID } from "node:crypto";

import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { zeroFeatureSwitchesRoutes } from "../zero-feature-switches";
import {
  deleteFeatureSwitches,
  seedFeatureSwitches,
  type FeatureSwitchesFixture,
} from "./helpers/zero-feature-switches";

const context = testContext();
const store = createStore();

function mockSession(userId: string, orgId: string | null): void {
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: true,
    toAuth: () => {
      return {
        userId,
        orgId,
        orgRole: orgId ? "org:admin" : undefined,
      };
    },
  });
}

describe("GET /api/zero/feature-switches", () => {
  const fixtures: FeatureSwitchesFixture[] = [];

  beforeEach(() => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
  });

  afterEach(async () => {
    while (fixtures.length > 0) {
      const fixture = fixtures.pop();
      if (fixture) {
        await deleteFeatureSwitches(store, fixture);
      }
    }
  });

  async function track(
    fixturePromise: Promise<FeatureSwitchesFixture>,
  ): Promise<FeatureSwitchesFixture> {
    const fixture = await fixturePromise;
    fixtures.push(fixture);
    return fixture;
  }

  it("returns persisted feature switch overrides", async () => {
    const fixture = await track(
      seedFeatureSwitches(store, {
        apiBackend: true,
        audioInput: false,
      }),
    );
    mockSession(fixture.userId, fixture.orgId);

    const client = setupApp({
      context,
      routes: zeroFeatureSwitchesRoutes("api"),
    })(zeroFeatureSwitchesContract);

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
    mockSession(userId, orgId);

    const client = setupApp({
      context,
      routes: zeroFeatureSwitchesRoutes("api"),
    })(zeroFeatureSwitchesContract);

    const response = await accept(
      client.get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ switches: {} });
  });

  it("requires authentication", async () => {
    const client = setupApp({
      context,
      routes: zeroFeatureSwitchesRoutes("api"),
    })(zeroFeatureSwitchesContract);

    const response = await accept(
      client.get({
        headers: {},
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("requires organization context", async () => {
    mockSession(`user_${randomUUID()}`, null);
    const client = setupApp({
      context,
      routes: zeroFeatureSwitchesRoutes("api"),
    })(zeroFeatureSwitchesContract);

    const response = await accept(
      client.get({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });
});
