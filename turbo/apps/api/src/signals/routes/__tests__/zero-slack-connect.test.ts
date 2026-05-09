import { zeroSlackConnectContract } from "@vm0/api-contracts/contracts/zero-slack-connect";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteSlackConnectOrg$,
  seedSlackConnectOrg$,
  type SlackConnectFixture,
} from "./helpers/zero-slack-connect";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

describe("GET /api/zero/integrations/slack/connect", () => {
  const track = createFixtureTracker<SlackConnectFixture>((fixture) => {
    return store.set(deleteSlackConnectOrg$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(zeroSlackConnectContract);

    const response = await accept(client.getStatus({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("returns 401 when the authenticated session has no active organization", async () => {
    const fixture = await track(
      store.set(seedSlackConnectOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, null);

    const client = setupApp({ context })(zeroSlackConnectContract);

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("returns isConnected: false when the user has no slack connection", async () => {
    const fixture = await track(
      store.set(seedSlackConnectOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(zeroSlackConnectContract);

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      isConnected: false,
      isAdmin: true,
    });
  });

  it("returns isConnected: true with workspace info when the user is connected", async () => {
    const fixture = await track(
      store.set(
        seedSlackConnectOrg$,
        { withConnection: true, slackWorkspaceName: "Test Workspace" },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(zeroSlackConnectContract);

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      isConnected: true,
      isAdmin: true,
      workspaceName: "Test Workspace",
      defaultAgentName: null,
    });
  });

  it("returns isAdmin: true for admin users", async () => {
    const fixture = await track(
      store.set(seedSlackConnectOrg$, { withConnection: true }, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(zeroSlackConnectContract);

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.isAdmin).toBeTruthy();
  });

  it("returns isAdmin: false for member users", async () => {
    const fixture = await track(
      store.set(seedSlackConnectOrg$, { withConnection: true }, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const client = setupApp({ context })(zeroSlackConnectContract);

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.isAdmin).toBeFalsy();
  });
});
