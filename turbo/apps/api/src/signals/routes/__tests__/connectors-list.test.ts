import { randomUUID } from "node:crypto";

import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import {
  connectorManualGrantContract,
  connectorsBySlugContract,
  connectorsMainContract,
} from "@okouai/api-contracts/contracts/connectors";
import { afterEach } from "vitest";

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
  setConnectorDefaultState,
} from "./helpers/connector-credential-storage-state";
import { createRouteMocks } from "./helpers/route-test";
import { connectorAccountRoutes } from "../connector-accounts";
import { connectorsRoutes } from "../connectors";

const context = testContext();
const mocks = createRouteMocks(context);

interface AuthenticatedFixture {
  readonly orgId: string;
  readonly userId: string;
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function seedAuthenticatedFixture(): AuthenticatedFixture {
  const fixture = {
    orgId: `org_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
  };
  mocks.clerk.session(fixture.userId, fixture.orgId);
  return fixture;
}

async function connectGitlab(fixture: AuthenticatedFixture): Promise<void> {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  await accept(
    setupApp({ context, routes: connectorsRoutes })(
      connectorManualGrantContract,
    ).connect({
      params: { connectorSlug: "gitlab" },
      body: {
        authMethod: "api-token",
        account: { intent: "add" },
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

async function deleteConnector(
  fixture: AuthenticatedFixture,
  connectorSlug: "gitlab" | "openai",
): Promise<void> {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  const client = setupApp({ context, routes: connectorAccountRoutes })(
    connectorAccountsContract,
  );
  const accounts = await accept(
    client.connections({
      headers: authHeaders(),
      query: { kind: "builtin", connectorSlug },
    }),
    [200, 404],
  );
  if (accounts.status === 404) {
    return;
  }
  for (const account of accounts.body.connections) {
    await accept(
      client.delete({
        headers: authHeaders(),
        params: { connectionId: account.id },
        body: { target: { kind: "builtin", connectorSlug } },
      }),
      [200],
    );
  }
}

describe("GET /api/connectors", () => {
  const seededFixtures: AuthenticatedFixture[] = [];

  afterEach(async () => {
    while (seededFixtures.length > 0) {
      const fixture = seededFixtures.pop();
      if (fixture) {
        await deleteConnector(fixture, "gitlab");
        await deleteConnector(fixture, "openai");
      }
    }
  });

  it("returns an empty connectors list", async () => {
    const fixture = seedAuthenticatedFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context, routes: connectorsRoutes })(
      connectorsMainContract,
    );
    const response = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );

    expect(response.body.connectors).toStrictEqual([]);
    expect(Array.isArray(response.body.connectorProvidedBindings)).toBeTruthy();
  });

  it("returns connectors created through the connector API", async () => {
    const fixture = seedAuthenticatedFixture();
    seededFixtures.push(fixture);
    await connectGitlab(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context, routes: connectorsRoutes })(
      connectorsMainContract,
    );
    const response = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );

    expect(response.body.connectors).toContainEqual(
      expect.objectContaining({
        slug: "gitlab",
        authMethod: "api-token",
        connectionStatus: "connected",
      }),
    );
    expect(response.body.connectorProvidedBindings).toContainEqual(
      expect.objectContaining({
        connectorSlug: "gitlab",
        namespace: "secrets",
        name: "GITLAB_TOKEN",
      }),
    );
  });

  it("projects only the default account for each connector target", async () => {
    const fixture = seedAuthenticatedFixture();
    seededFixtures.push(fixture);
    await connectGitlab(fixture);
    const state = await readConnectorCredentialStorageState(context, {
      orgId: fixture.orgId,
      userId: fixture.userId,
      connectorSlug: "gitlab",
    });
    const connectorId = state.connector?.id;
    if (!connectorId) {
      throw new Error("Expected a stored GitLab connector account");
    }
    await setConnectorDefaultState(context, {
      orgId: fixture.orgId,
      userId: fixture.userId,
      connectorId,
      isDefault: false,
    });

    const response = await accept(
      setupApp({ context, routes: connectorsRoutes })(
        connectorsMainContract,
      ).list({ headers: authHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({
      connectors: [],
      connectorProvidedBindings: [],
    });

    const detail = await accept(
      setupApp({ context, routes: connectorsRoutes })(
        connectorsBySlugContract,
      ).get({
        params: { connectorSlug: "gitlab" },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(detail.body.error.code).toBe("NOT_FOUND");
  });

  it("skips stored connectors whose runtime method is unavailable", async () => {
    const fixture = seedAuthenticatedFixture();
    seededFixtures.push(fixture);
    await connectGitlab(fixture);
    await seedConnectorStorageRow(context, {
      orgId: fixture.orgId,
      userId: fixture.userId,
      connectorSlug: "openai",
      authMethod: "unavailable-method",
      storageVersion: 1,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context, routes: connectorsRoutes })(
      connectorsMainContract,
    );
    const response = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );

    expect(response.body.connectors).toHaveLength(1);
    expect(response.body.connectors[0]).toMatchObject({ slug: "gitlab" });
    expect(response.body.connectorProvidedBindings).not.toContainEqual(
      expect.objectContaining({ connectorSlug: "openai" }),
    );
  });

  it("skips stored connectors when the external catalog is unavailable", async () => {
    const fixture = seedAuthenticatedFixture();
    seededFixtures.push(fixture);
    await connectGitlab(fixture);
    mockOptionalEnv("BOX_OAUTH_CLIENT_ID", undefined);
    await installApiTestConnectorCatalog();
    await invalidateApiTestConnectorCatalogCompatibility();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context, routes: connectorsRoutes })(
      connectorsMainContract,
    );
    const response = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({
      connectors: [],
      connectorProvidedBindings: [],
    });
  });

  it("returns 401 when not authenticated", async () => {
    const client = setupApp({ context, routes: connectorsRoutes })(
      connectorsMainContract,
    );
    const response = await accept(client.list({ headers: {} }), [401]);

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({ context, routes: connectorsRoutes })(
      connectorsMainContract,
    );
    const response = await accept(
      client.list({ headers: authHeaders() }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });
});
