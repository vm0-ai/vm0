import { randomUUID } from "node:crypto";

import { zeroComputerUseHostContract } from "@vm0/api-contracts/contracts/zero-computer-use";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  type ComputerUseScenarioFixture,
  deleteComputerUseScenario$,
  seedComputerUseScenario$,
} from "./helpers/zero-computer-use";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

describe("GET /api/zero/computer-use/host", () => {
  const track = createFixtureTracker<ComputerUseScenarioFixture>((fixture) => {
    return store.set(deleteComputerUseScenario$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(zeroComputerUseHostContract);

    const response = await accept(client.getHost({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, null);

    const client = setupApp({ context })(zeroComputerUseHostContract);

    const response = await accept(
      client.getHost({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 403 when the computer-use feature switch is disabled", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroComputerUseHostContract);

    const response = await accept(
      client.getHost({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [403],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Computer use is not enabled", code: "FORBIDDEN" },
    });
  });

  it("returns 404 when no active host is registered", async () => {
    const fixture = await track(
      store.set(
        seedComputerUseScenario$,
        { computerUseEnabled: true },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroComputerUseHostContract);

    const response = await accept(
      client.getHost({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: { message: "No active computer-use host", code: "NOT_FOUND" },
    });
  });

  it("returns host details when a host is registered", async () => {
    const fixture = await track(
      store.set(
        seedComputerUseScenario$,
        {
          computerUseEnabled: true,
          host: {
            domain: "abc.ngrok-free.app",
            token: "host_token_xyz",
          },
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroComputerUseHostContract);

    const response = await accept(
      client.getHost({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      domain: "abc.ngrok-free.app",
      token: "host_token_xyz",
    });
  });
});
