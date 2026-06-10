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

// BDD migration of the legacy `zero-custom-connectors.test.ts`. The
// Given uses `seedCustomConnectorOrg$` (recorded under "Open Helper
// Gaps" in `api.bdd.md`). The 5 legacy `it()`s collapse into 2 BDD
// `it()`s (auth boundary + a gwt-wt-wt chain that exercises empty →
// with-secret → without-secret listings in one shared session shape).

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function client() {
  return setupApp({ context })(zeroCustomConnectorsContract);
}

describe("BDD GET /api/zero/custom-connectors — auth boundary", () => {
  it("rejects unauthenticated and org-less sessions", async () => {
    const c = client();

    // When + Then: no auth header → 401.
    const unauth = await accept(c.list({ headers: {} }), [401]);
    expect(unauth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a session with a user but no org.
    const fixture = await track(
      store.set(seedCustomConnectorOrg$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, null);

    // When + Then: still 401.
    const noOrg = await accept(c.list({ headers: authHeaders() }), [401]);
    expect(noOrg.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });
});

const track = createFixtureTracker<CustomConnectorFixture>((fixture) => {
  return store.set(deleteCustomConnectorOrg$, fixture, context.signal);
});

describe("BDD GET /api/zero/custom-connectors — list chain", () => {
  it("gwt-wt-wt: empty → with-secret (hasSecret: true) → without-secret (hasSecret: false)", async () => {
    const c = client();

    // Given: a fresh user/org with no custom connectors.
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);

    // When + Then: the list is empty.
    const empty = await accept(c.list({ headers: authHeaders() }), [200]);
    expect(empty.body).toStrictEqual({ connectors: [] });

    // Given: a connector with a per-user secret.
    const withSecretFixture = await track(
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
    mocks.clerk.session(withSecretFixture.userId, withSecretFixture.orgId);

    // When + Then: the connector is listed with `hasSecret: true`.
    const withSecret = await accept(c.list({ headers: authHeaders() }), [200]);
    expect(withSecret.body).toStrictEqual({
      connectors: [
        {
          id: withSecretFixture.connectorId,
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

    // Given: a connector without a per-user secret.
    const withoutSecretFixture = await track(
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
    mocks.clerk.session(
      withoutSecretFixture.userId,
      withoutSecretFixture.orgId,
    );

    // When + Then: the connector is listed with `hasSecret: false`.
    const withoutSecret = await accept(
      c.list({ headers: authHeaders() }),
      [200],
    );
    expect(withoutSecret.body).toStrictEqual({
      connectors: [
        {
          id: withoutSecretFixture.connectorId,
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
});
