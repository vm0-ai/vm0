import { randomUUID } from "node:crypto";

import {
  zeroConnectorManualGrantContract,
  zeroConnectorsByTypeContract,
} from "@vm0/api-contracts/contracts/zero-connectors";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

interface AuthenticatedFixture {
  readonly orgId: string;
  readonly userId: string;
}

type ConnectorToCleanUp = "openai" | "atlassian" | "gitlab";

const CONNECTOR_TYPES_TO_CLEAN_UP: readonly ConnectorToCleanUp[] = [
  "openai",
  "atlassian",
  "gitlab",
];

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function seedFixture(): Promise<AuthenticatedFixture> {
  const fixture = {
    orgId: `org_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
  };
  mocks.clerk.session(fixture.userId, fixture.orgId);
  return Promise.resolve(fixture);
}

async function connectOpenai(fixture: AuthenticatedFixture): Promise<void> {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  await accept(
    setupApp({ context })(zeroConnectorManualGrantContract).connect({
      params: { type: "openai" },
      body: {
        authMethod: "api-token",
        values: { OPENAI_TOKEN: "sk-test-token" },
      },
      headers: authHeaders(),
    }),
    [200],
  );
}

async function connectAtlassian(fixture: AuthenticatedFixture): Promise<void> {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  await accept(
    setupApp({ context })(zeroConnectorManualGrantContract).connect({
      params: { type: "atlassian" },
      body: {
        authMethod: "api-token",
        values: {
          ATLASSIAN_TOKEN: "atlassian-test-token",
          ATLASSIAN_EMAIL: "test@example.com",
          ATLASSIAN_DOMAIN: "example",
        },
      },
      headers: authHeaders(),
    }),
    [200],
  );
}

async function connectGitlab(fixture: AuthenticatedFixture): Promise<void> {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  await accept(
    setupApp({ context })(zeroConnectorManualGrantContract).connect({
      params: { type: "gitlab" },
      body: {
        authMethod: "api-token",
        values: {
          GITLAB_TOKEN: "gl-test-token",
          GITLAB_HOST: "gitlab.example.com",
        },
      },
      headers: authHeaders(),
    }),
    [200],
  );
}

async function readExistingConnector(
  fixture: AuthenticatedFixture,
  type: ConnectorToCleanUp,
) {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  return await accept(
    setupApp({ context })(zeroConnectorsByTypeContract).get({
      params: { type },
      headers: authHeaders(),
    }),
    [200],
  );
}

async function readMissingConnector(
  fixture: AuthenticatedFixture,
  type: ConnectorToCleanUp,
) {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  return await accept(
    setupApp({ context })(zeroConnectorsByTypeContract).get({
      params: { type },
      headers: authHeaders(),
    }),
    [404],
  );
}

async function deleteConnector(
  fixture: AuthenticatedFixture,
  type: ConnectorToCleanUp,
  statuses: readonly [204] | readonly [204, 404] | readonly [404],
) {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  return await accept(
    setupApp({ context })(zeroConnectorsByTypeContract).delete({
      params: { type },
      headers: authHeaders(),
    }),
    statuses,
  );
}

async function cleanupFixture(fixture: AuthenticatedFixture): Promise<void> {
  for (const type of CONNECTOR_TYPES_TO_CLEAN_UP) {
    await deleteConnector(fixture, type, [204, 404]);
  }
}

describe("DELETE /api/zero/connectors/:type", () => {
  const track = createFixtureTracker<AuthenticatedFixture>(cleanupFixture);

  it("returns 401 when not authenticated", async () => {
    const client = setupApp({ context })(zeroConnectorsByTypeContract);
    const response = await accept(
      client.delete({ params: { type: "github" }, headers: {} }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({ context })(zeroConnectorsByTypeContract);
    const response = await accept(
      client.delete({
        params: { type: "github" },
        headers: authHeaders(),
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 404 when no connector state exists for that type", async () => {
    const fixture = await track(seedFixture());
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await deleteConnector(fixture, "openai", [404]);

    expect(response.body).toStrictEqual({
      error: { message: "Connector not found", code: "NOT_FOUND" },
    });
  });

  it("deletes a connector created through the connector API", async () => {
    const fixture = await track(seedFixture());
    await connectOpenai(fixture);

    const response = await deleteConnector(fixture, "openai", [204]);

    expect(response.body).toBeUndefined();
    const readAfterDelete = await readMissingConnector(fixture, "openai");
    expect(readAfterDelete.body.error.code).toBe("NOT_FOUND");
  });

  it("deletes API-token connector state created through manual grant", async () => {
    const fixture = await track(seedFixture());
    await connectAtlassian(fixture);

    const response = await deleteConnector(fixture, "atlassian", [204]);

    expect(response.body).toBeUndefined();
    const readAfterDelete = await readMissingConnector(fixture, "atlassian");
    expect(readAfterDelete.body.error.code).toBe("NOT_FOUND");
  });

  it("deletes optional API-token connector state created through manual grant", async () => {
    const fixture = await track(seedFixture());
    await connectGitlab(fixture);

    const response = await deleteConnector(fixture, "gitlab", [204]);

    expect(response.body).toBeUndefined();
    const readAfterDelete = await readMissingConnector(fixture, "gitlab");
    expect(readAfterDelete.body.error.code).toBe("NOT_FOUND");
  });

  it("deletes only the requested connector type", async () => {
    const fixture = await track(seedFixture());
    await connectAtlassian(fixture);
    await connectGitlab(fixture);

    await deleteConnector(fixture, "atlassian", [204]);

    const deleted = await readMissingConnector(fixture, "atlassian");
    expect(deleted.body.error.code).toBe("NOT_FOUND");
    const preserved = await readExistingConnector(fixture, "gitlab");
    expect(preserved.body).toMatchObject({
      type: "gitlab",
      authMethod: "api-token",
      connectionStatus: "connected",
    });
  });
});
