import { randomUUID } from "node:crypto";

import {
  zeroConnectorManualGrantContract,
  zeroConnectorsBySlugContract,
} from "@okouai/api-contracts/contracts/zero-connectors";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import {
  invalidateApiTestConnectorCatalogCompatibility,
  installApiTestConnectorCatalog,
} from "../../../test-fixtures/connector-catalog";
import {
  readConnectorCredentialStorageState,
  seedConnectorStorageRow,
} from "./helpers/connector-credential-storage-state";
import { createFixtureTracker, createRouteMocks } from "./helpers/route-test";
import { connectorsRoutes } from "../connectors";

const context = testContext();
const mocks = createRouteMocks(context);

interface AuthenticatedFixture {
  readonly orgId: string;
  readonly userId: string;
}

type ConnectorSlugToCleanUp = "openai" | "gitlab" | "removed-connector";

const CONNECTOR_SLUGS_TO_CLEAN_UP: readonly ConnectorSlugToCleanUp[] = [
  "openai",
  "gitlab",
  "removed-connector",
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
    setupApp({ context, routes: connectorsRoutes })(
      zeroConnectorManualGrantContract,
    ).connect({
      params: { connectorSlug: "openai" },
      body: {
        authMethod: "api-token",
        values: { apiKey: "sk-test-token" },
      },
      headers: authHeaders(),
    }),
    [200],
  );
}

async function connectGitlab(fixture: AuthenticatedFixture): Promise<void> {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  await accept(
    setupApp({ context, routes: connectorsRoutes })(
      zeroConnectorManualGrantContract,
    ).connect({
      params: { connectorSlug: "gitlab" },
      body: {
        authMethod: "api-token",
        values: {
          accessToken: "gl-test-token",
          host: "gitlab.example.com",
        },
      },
      headers: authHeaders(),
    }),
    [200],
  );
}

async function readExistingConnector(
  fixture: AuthenticatedFixture,
  connectorSlug: ConnectorSlugToCleanUp,
) {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  return await accept(
    setupApp({ context, routes: connectorsRoutes })(
      zeroConnectorsBySlugContract,
    ).get({
      params: { connectorSlug },
      headers: authHeaders(),
    }),
    [200],
  );
}

async function readMissingConnector(
  fixture: AuthenticatedFixture,
  connectorSlug: ConnectorSlugToCleanUp,
) {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  return await accept(
    setupApp({ context, routes: connectorsRoutes })(
      zeroConnectorsBySlugContract,
    ).get({
      params: { connectorSlug },
      headers: authHeaders(),
    }),
    [404],
  );
}

async function deleteConnector(
  fixture: AuthenticatedFixture,
  connectorSlug: ConnectorSlugToCleanUp,
  statuses: readonly [204] | readonly [204, 404] | readonly [404],
) {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  return await accept(
    setupApp({ context, routes: connectorsRoutes })(
      zeroConnectorsBySlugContract,
    ).delete({
      params: { connectorSlug },
      headers: authHeaders(),
    }),
    statuses,
  );
}

async function cleanupFixture(fixture: AuthenticatedFixture): Promise<void> {
  for (const connectorSlug of CONNECTOR_SLUGS_TO_CLEAN_UP) {
    await deleteConnector(fixture, connectorSlug, [204, 404]);
  }
}

describe("DELETE /api/connectors/:connectorSlug", () => {
  const track = createFixtureTracker<AuthenticatedFixture>(cleanupFixture);

  it("returns 401 when not authenticated", async () => {
    const client = setupApp({ context, routes: connectorsRoutes })(
      zeroConnectorsBySlugContract,
    );
    const response = await accept(
      client.delete({ params: { connectorSlug: "github" }, headers: {} }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({ context, routes: connectorsRoutes })(
      zeroConnectorsBySlugContract,
    );
    const response = await accept(
      client.delete({
        params: { connectorSlug: "github" },
        headers: authHeaders(),
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 404 when no connector state exists for that slug", async () => {
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

  it("deletes optional API-token connector state created through manual grant", async () => {
    const fixture = await track(seedFixture());
    await connectGitlab(fixture);

    const response = await deleteConnector(fixture, "gitlab", [204]);

    expect(response.body).toBeUndefined();
    const readAfterDelete = await readMissingConnector(fixture, "gitlab");
    expect(readAfterDelete.body.error.code).toBe("NOT_FOUND");
  });

  it("deletes local state when the connector runtime method is unavailable", async () => {
    const fixture = await track(seedFixture());
    await seedConnectorStorageRow(context, {
      orgId: fixture.orgId,
      userId: fixture.userId,
      connectorSlug: "removed-connector",
      authMethod: "unavailable-method",
      storageVersion: 1,
    });

    const response = await deleteConnector(fixture, "removed-connector", [204]);

    expect(response.body).toBeUndefined();
    const storageState = await readConnectorCredentialStorageState(context, {
      orgId: fixture.orgId,
      userId: fixture.userId,
      connectorSlug: "removed-connector",
    });
    expect(storageState.connector).toBeNull();
  });

  it("deletes local state when the external catalog is unavailable", async () => {
    const fixture = await track(seedFixture());
    await connectOpenai(fixture);
    mockOptionalEnv("CLOSE_OAUTH_CLIENT_ID", undefined);
    await installApiTestConnectorCatalog();
    await invalidateApiTestConnectorCatalogCompatibility();

    const response = await deleteConnector(fixture, "openai", [204]);

    expect(response.body).toBeUndefined();
    const storageState = await readConnectorCredentialStorageState(context, {
      orgId: fixture.orgId,
      userId: fixture.userId,
      connectorSlug: "openai",
    });
    expect(storageState.connector).toBeNull();
  });

  it("deletes only the requested connector slug", async () => {
    const fixture = await track(seedFixture());
    await connectOpenai(fixture);
    await connectGitlab(fixture);

    await deleteConnector(fixture, "openai", [204]);

    const deleted = await readMissingConnector(fixture, "openai");
    expect(deleted.body.error.code).toBe("NOT_FOUND");
    const preserved = await readExistingConnector(fixture, "gitlab");
    expect(preserved.body).toMatchObject({
      slug: "gitlab",
      authMethod: "api-token",
      connectionStatus: "connected",
    });
  });
});
