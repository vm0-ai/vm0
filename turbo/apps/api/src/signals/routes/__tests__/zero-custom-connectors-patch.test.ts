import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  zeroCustomConnectorByIdContract,
  zeroCustomConnectorsContract,
  type CustomConnectorResponse,
} from "@vm0/api-contracts/contracts/zero-custom-connectors";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

interface CustomConnectorFixture {
  readonly userId: string;
  readonly orgId: string;
  readonly connector: CustomConnectorResponse;
}

interface OrgSession {
  readonly orgId: string;
  readonly userId: string;
}

interface ConnectorBodyOptions {
  readonly displayName?: string;
  readonly slug?: string;
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function uniqueOrg(prefix: string): OrgSession {
  return {
    userId: `user_${prefix}_${randomUUID().slice(0, 8)}`,
    orgId: `org_${prefix}_${randomUUID().slice(0, 8)}`,
  };
}

function validConnectorBody(options: ConnectorBodyOptions = {}) {
  const body = {
    displayName: options.displayName ?? "Original",
    prefixes: ["https://api.example.com/"],
    headerName: "Authorization",
    headerTemplate: "Bearer {{secret}}",
  };
  if (options.slug) {
    return { ...body, slug: options.slug };
  }
  return body;
}

async function createConnector(
  track: (
    fixturePromise: Promise<CustomConnectorFixture>,
  ) => Promise<CustomConnectorFixture>,
  session: OrgSession = uniqueOrg("zcc-patch"),
  bodyOptions: ConnectorBodyOptions = {},
) {
  mocks.clerk.session(session.userId, session.orgId, "org:admin");
  const client = setupApp({ context })(zeroCustomConnectorsContract);
  const response = await accept(
    client.create({
      body: validConnectorBody(bodyOptions),
      headers: authHeaders(),
    }),
    [201],
  );
  return track(Promise.resolve({ ...session, connector: response.body }));
}

async function listConnectors() {
  const client = setupApp({ context })(zeroCustomConnectorsContract);
  const response = await accept(client.list({ headers: authHeaders() }), [200]);
  return response.body.connectors;
}

describe("PATCH /api/zero/custom-connectors/:id", () => {
  const track = createFixtureTracker<CustomConnectorFixture>(
    async (fixture) => {
      mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
      const client = setupApp({ context })(zeroCustomConnectorByIdContract);
      await accept(
        client.delete({
          params: { id: fixture.connector.id },
          headers: authHeaders(),
        }),
        [204, 404],
      );
    },
  );

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(zeroCustomConnectorByIdContract);
    const response = await accept(
      client.patch({
        params: { id: randomUUID() },
        headers: {},
        body: { displayName: "Renamed" },
      }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when the authenticated session has no active organization", async () => {
    const { userId } = uniqueOrg("zcc-patch-no-org");
    mocks.clerk.session(userId, null);

    const client = setupApp({ context })(zeroCustomConnectorByIdContract);
    const response = await accept(
      client.patch({
        params: { id: randomUUID() },
        headers: authHeaders(),
        body: { displayName: "Renamed" },
      }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 403 for non-admin members", async () => {
    const fixture = await createConnector(track, uniqueOrg("zcc-patch-member"));
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const client = setupApp({ context })(zeroCustomConnectorByIdContract);
    const response = await accept(
      client.patch({
        params: { id: fixture.connector.id },
        headers: authHeaders(),
        body: { displayName: "Hacked" },
      }),
      [403],
    );
    expect(response.body).toStrictEqual({
      error: {
        message: "Only org admins can rename custom connectors",
        code: "FORBIDDEN",
      },
    });

    const connectors = await listConnectors();
    expect(connectors).toContainEqual(fixture.connector);
  });

  it("renames a connector as admin and exposes the new name through list", async () => {
    const fixture = await createConnector(track, uniqueOrg("zcc-patch-happy"), {
      displayName: "Original",
      slug: "patch-happy",
    });
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(zeroCustomConnectorByIdContract);
    const response = await accept(
      client.patch({
        params: { id: fixture.connector.id },
        headers: authHeaders(),
        body: { displayName: "Renamed" },
      }),
      [200],
    );

    expect(response.body.id).toBe(fixture.connector.id);
    expect(response.body.displayName).toBe("Renamed");
    expect(response.body.slug).toBe("patch-happy");
    expect(response.body.hasSecret).toBeFalsy();

    const connectors = await listConnectors();
    expect(connectors).toContainEqual(response.body);
  });

  it("returns 404 for an unknown connector id", async () => {
    const session = uniqueOrg("zcc-patch-unknown");
    mocks.clerk.session(session.userId, session.orgId, "org:admin");
    const unknownId = randomUUID();

    const client = setupApp({ context })(zeroCustomConnectorByIdContract);
    const response = await accept(
      client.patch({
        params: { id: unknownId },
        headers: authHeaders(),
        body: { displayName: "Renamed" },
      }),
      [404],
    );
    expect(response.body).toMatchObject({
      error: { code: "NOT_FOUND", message: "Custom connector not found" },
    });
  });

  it("returns 404 when the connector belongs to another org (no existence leak)", async () => {
    const otherFixture = await createConnector(
      track,
      uniqueOrg("zcc-patch-other"),
      { displayName: "OtherOrg" },
    );

    const mySession = uniqueOrg("zcc-patch-mine");
    mocks.clerk.session(mySession.userId, mySession.orgId, "org:admin");

    const client = setupApp({ context })(zeroCustomConnectorByIdContract);
    const response = await accept(
      client.patch({
        params: { id: otherFixture.connector.id },
        headers: authHeaders(),
        body: { displayName: "Hijacked" },
      }),
      [404],
    );
    expect(response.body).toMatchObject({
      error: { code: "NOT_FOUND", message: "Custom connector not found" },
    });

    mocks.clerk.session(otherFixture.userId, otherFixture.orgId, "org:admin");
    const connectors = await listConnectors();
    expect(connectors).toContainEqual(otherFixture.connector);
  });

  it("rejects empty displayName with 400", async () => {
    const fixture = await createConnector(track, uniqueOrg("zcc-patch-empty"));
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(zeroCustomConnectorByIdContract);
    const response = await accept(
      client.patch({
        params: { id: fixture.connector.id },
        headers: authHeaders(),
        body: { displayName: "" },
      }),
      [400],
    );
    expect(response.body).toMatchObject({
      error: { code: "BAD_REQUEST" },
    });

    const connectors = await listConnectors();
    expect(connectors).toContainEqual(fixture.connector);
  });
});
