import { randomUUID } from "node:crypto";

import { zeroCustomConnectorsContract } from "@vm0/api-contracts/contracts/zero-custom-connectors";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteCustomConnectorOrg$,
  seedCustomConnectorOrg$,
  type CustomConnectorFixture,
} from "./helpers/zero-custom-connectors";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

describe("GET /api/zero/custom-connectors", () => {
  const track = createFixtureTracker<CustomConnectorFixture>((fixture) => {
    return store.set(deleteCustomConnectorOrg$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(zeroCustomConnectorsContract);

    const response = await accept(client.list({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("returns 401 when the authenticated session has no active organization", async () => {
    const fixture = await track(
      store.set(seedCustomConnectorOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, null);

    const client = setupApp({ context })(zeroCustomConnectorsContract);

    const response = await accept(
      client.list({
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

  it("returns an empty list when the org has no custom connectors", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroCustomConnectorsContract);

    const response = await accept(
      client.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ connectors: [] });
  });

  it("lists the org connectors with hasSecret: false when no per-user secret is set", async () => {
    const fixture = await track(
      store.set(
        seedCustomConnectorOrg$,
        {
          slug: "example-connector",
          displayName: "Example",
          prefixes: ["https://api.example.com/"],
          headerName: "Authorization",
          headerTemplate: "Bearer {{secret}}",
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroCustomConnectorsContract);

    const response = await accept(
      client.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      connectors: [
        {
          id: fixture.connectorId,
          slug: "example-connector",
          displayName: "Example",
          prefixes: ["https://api.example.com/"],
          headerName: "Authorization",
          headerTemplate: "Bearer {{secret}}",
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
          hasSecret: false,
        },
      ],
    });
  });

  it("lists the org connectors with hasSecret: true when the user has a secret", async () => {
    const fixture = await track(
      store.set(
        seedCustomConnectorOrg$,
        {
          slug: "example-connector",
          displayName: "Example",
          prefixes: ["https://api.example.com/"],
          headerName: "Authorization",
          headerTemplate: "Bearer {{secret}}",
          withSecret: true,
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroCustomConnectorsContract);

    const response = await accept(
      client.list({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      connectors: [
        {
          id: fixture.connectorId,
          slug: "example-connector",
          displayName: "Example",
          prefixes: ["https://api.example.com/"],
          headerName: "Authorization",
          headerTemplate: "Bearer {{secret}}",
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
          hasSecret: true,
        },
      ],
    });
  });
});
