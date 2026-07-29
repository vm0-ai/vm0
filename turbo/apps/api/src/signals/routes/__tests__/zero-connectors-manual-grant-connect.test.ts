import { randomUUID } from "node:crypto";

import {
  zeroConnectorManualGrantContract,
  zeroConnectorsBySlugContract,
  zeroConnectorsMainContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { afterEach } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import {
  readConnectorCredentialStorageState,
  seedConnectorStorageRow,
  seedOwnedConnectorSecret,
} from "./helpers/connector-credential-storage-state";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

interface AuthenticatedFixture {
  readonly orgId: string;
  readonly userId: string;
}

const CONNECTOR_SLUGS_TO_CLEAN_UP = [
  "openai",
  "zendesk",
  "insforge",
  "lark",
  "test-oauth",
  "gitlab",
  "bentoml",
  "github",
] as const;

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function featureSwitchesClient() {
  return setupApp({ context })(zeroFeatureSwitchesContract);
}

function seedAuthenticatedFixture(): AuthenticatedFixture {
  const fixture = {
    orgId: `org_${randomUUID()}`,
    userId: `user_${randomUUID()}`,
  };
  mocks.clerk.session(fixture.userId, fixture.orgId);
  return fixture;
}

async function updateFeatureSwitches(
  fixture: AuthenticatedFixture,
  switches: Partial<Record<FeatureSwitchKey, boolean>>,
): Promise<void> {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  await accept(
    featureSwitchesClient().update({
      headers: authHeaders(),
      body: { switches },
    }),
    [200],
  );
}

async function deleteFeatureSwitches(
  fixture: AuthenticatedFixture,
): Promise<void> {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  await accept(
    featureSwitchesClient().delete({ headers: authHeaders() }),
    [200],
  );
}

async function deleteConnector(
  fixture: AuthenticatedFixture,
  connectorSlug: (typeof CONNECTOR_SLUGS_TO_CLEAN_UP)[number],
): Promise<void> {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  await accept(
    setupApp({ context })(zeroConnectorsBySlugContract).delete({
      params: { type: connectorSlug },
      headers: authHeaders(),
    }),
    [204, 404],
  );
}

async function cleanupFixture(fixture: AuthenticatedFixture): Promise<void> {
  await deleteFeatureSwitches(fixture);
  for (const connectorSlug of CONNECTOR_SLUGS_TO_CLEAN_UP) {
    await deleteConnector(fixture, connectorSlug);
  }
}

async function readConnector(
  fixture: AuthenticatedFixture,
  connectorSlug: (typeof CONNECTOR_SLUGS_TO_CLEAN_UP)[number],
) {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  return await accept(
    setupApp({ context })(zeroConnectorsBySlugContract).get({
      params: { type: connectorSlug },
      headers: authHeaders(),
    }),
    [200],
  );
}

describe("POST /api/zero/connectors/:type/manual-grant", () => {
  const fixtures: AuthenticatedFixture[] = [];

  afterEach(async () => {
    while (fixtures.length > 0) {
      const fixture = fixtures.pop();
      if (fixture) {
        await cleanupFixture(fixture);
      }
    }
  });

  function seedFixture(): AuthenticatedFixture {
    const fixture = seedAuthenticatedFixture();
    fixtures.push(fixture);
    return fixture;
  }

  it("returns 401 when not authenticated", async () => {
    const client = setupApp({ context })(zeroConnectorManualGrantContract);
    const response = await accept(
      client.connect({
        params: { type: "openai" },
        body: { authMethod: "api-token", values: { apiKey: "sk-test" } },
        headers: {},
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({ context })(zeroConnectorManualGrantContract);
    const response = await accept(
      client.connect({
        params: { type: "openai" },
        body: { authMethod: "api-token", values: { apiKey: "sk-test" } },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects requests without a selected auth method", async () => {
    await seedFixture();
    const app = createApp({ signal: context.signal });

    const response = await app.request(
      "/api/zero/connectors/openai/manual-grant",
      {
        method: "POST",
        headers: {
          authorization: "Bearer clerk-session",
          "content-type": "application/json",
        },
        body: JSON.stringify({ values: { apiKey: "sk-test" } }),
      },
    );

    expect(response.status).toBe(400);
  });

  it("accepts server-authored identity syntax before catalog rejection", async () => {
    await seedFixture();
    const connectorSlug = "server-authored-connector";
    const authMethod = "server-authored-method";
    const client = setupApp({ context })(zeroConnectorManualGrantContract);

    const response = await accept(
      client.connect({
        params: { type: connectorSlug },
        body: { authMethod, values: { apiKey: "secret" } },
        headers: authHeaders(),
      }),
      [400],
    );

    expect(response.body.error).toStrictEqual({
      message: `${connectorSlug} connector is not supported`,
      code: "BAD_REQUEST",
    });
    const list = await accept(
      setupApp({ context })(zeroConnectorsMainContract).list({
        headers: authHeaders(),
      }),
      [200],
    );
    expect(list.body.connectors).not.toContainEqual(
      expect.objectContaining({ type: connectorSlug }),
    );
  });

  it("rejects invalid server-authored identity syntax at the contract", async () => {
    await seedFixture();
    const app = createApp({ signal: context.signal });

    const response = await app.request(
      "/api/zero/connectors/invalid_ref/manual-grant",
      {
        method: "POST",
        headers: {
          authorization: "Bearer clerk-session",
          "content-type": "application/json",
        },
        body: JSON.stringify({ authMethod: "api-token", values: {} }),
      },
    );

    expect(response.status).toBe(400);
  });

  it("connects a first-time manual grant connector with connector-owned state", async () => {
    const fixture = await seedFixture();
    const client = setupApp({ context })(zeroConnectorManualGrantContract);

    const response = await accept(
      client.connect({
        params: { type: "openai" },
        body: {
          authMethod: "api-token",
          values: { apiKey: " sk-test\n" },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      type: "openai",
      authMethod: "api-token",
    });
    expect(typeof response.body.id).toBe("string");
    expect(response.body.createdAt).not.toBe("1970-01-01T00:00:00.000Z");
    expect(response.body.updatedAt).not.toBe("1970-01-01T00:00:00.000Z");
    const stored = await readConnector(fixture, "openai");
    expect(stored.body).toMatchObject({
      type: "openai",
      authMethod: "api-token",
      connectionStatus: "connected",
    });
  });

  it("connects Zendesk manual grant fields through the API", async () => {
    const fixture = await seedFixture();
    const client = setupApp({ context })(zeroConnectorManualGrantContract);

    const response = await accept(
      client.connect({
        params: { type: "zendesk" },
        body: {
          authMethod: "api-token",
          values: {
            apiToken: " zendesk\n-token ",
            email: " support@example.com ",
            subdomain: " example ",
          },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      type: "zendesk",
      authMethod: "api-token",
      connectionStatus: "connected",
    });
    const stored = await readConnector(fixture, "zendesk");
    expect(stored.body.authMethod).toBe("api-token");

    const storageState = await readConnectorCredentialStorageState(context, {
      orgId: fixture.orgId,
      userId: fixture.userId,
      connectorSlug: "zendesk",
      secretNames: ["ZENDESK_API_TOKEN"],
      variableNames: ["ZENDESK_EMAIL", "ZENDESK_SUBDOMAIN"],
    });
    expect(storageState.connector).toStrictEqual({
      id: response.body.id,
      storage_version: 1,
    });
    expect(storageState.secrets).toStrictEqual([
      expect.objectContaining({
        name: "ZENDESK_API_TOKEN",
        connector_id: response.body.id,
      }),
    ]);
    expect(storageState.variables).toStrictEqual(
      expect.arrayContaining([
        { name: "ZENDESK_EMAIL", connector_id: response.body.id },
        { name: "ZENDESK_SUBDOMAIN", connector_id: response.body.id },
      ]),
    );
  });

  it("deletes connector-owned secret and variable state on disconnect", async () => {
    const fixture = await seedFixture();
    await accept(
      setupApp({ context })(zeroConnectorManualGrantContract).connect({
        params: { type: "zendesk" },
        body: {
          authMethod: "api-token",
          values: {
            apiToken: "zendesk-token",
            email: "support@example.com",
            subdomain: "example",
          },
        },
        headers: authHeaders(),
      }),
      [200],
    );

    await deleteConnector(fixture, "zendesk");

    const storageState = await readConnectorCredentialStorageState(context, {
      orgId: fixture.orgId,
      userId: fixture.userId,
      connectorSlug: "zendesk",
      secretNames: ["ZENDESK_API_TOKEN"],
      variableNames: ["ZENDESK_EMAIL", "ZENDESK_SUBDOMAIN"],
    });
    expect(storageState.connector).toBeNull();
    expect(storageState.secrets).toStrictEqual([]);
    expect(storageState.variables).toStrictEqual([]);
  });

  it("preserves a foreign-owned credential when reconnecting an existing connector", async () => {
    const fixture = await seedFixture();
    const ownerId = await seedOwnedConnectorSecret(context, {
      orgId: fixture.orgId,
      userId: fixture.userId,
      connectorSlug: "github",
      authMethod: "oauth",
      storageVersion: 1,
      name: "OPENAI_TOKEN",
      encryptedValue: "owner-value",
      description: "owner description",
    });
    await seedConnectorStorageRow(context, {
      orgId: fixture.orgId,
      userId: fixture.userId,
      connectorSlug: "openai",
      authMethod: "api-token",
      storageVersion: 1,
    });

    const response = await createApp({ signal: context.signal }).request(
      "/api/zero/connectors/openai/manual-grant",
      {
        method: "POST",
        headers: {
          authorization: "Bearer clerk-session",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          authMethod: "api-token",
          values: { apiKey: "replacement" },
        }),
      },
    );
    expect(response.status).toBe(500);

    const storageState = await readConnectorCredentialStorageState(context, {
      orgId: fixture.orgId,
      userId: fixture.userId,
      connectorSlug: "openai",
      secretNames: ["OPENAI_TOKEN"],
    });
    expect(storageState.secrets?.[0]).toStrictEqual({
      name: "OPENAI_TOKEN",
      connector_id: ownerId,
      encrypted_value: "owner-value",
      description: "owner description",
    });
    expect(storageState.connector?.storage_version).toBe(1);

    await deleteConnector(fixture, "openai");
    const stateAfterDelete = await readConnectorCredentialStorageState(
      context,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        connectorSlug: "github",
        secretNames: ["OPENAI_TOKEN"],
      },
    );
    expect(stateAfterDelete.secrets?.[0]).toStrictEqual({
      name: "OPENAI_TOKEN",
      connector_id: ownerId,
      encrypted_value: "owner-value",
      description: "owner description",
    });
  });

  it("normalizes a full URL host field for manual grant connectors", async () => {
    const fixture = await seedFixture();
    const client = setupApp({ context })(zeroConnectorManualGrantContract);

    const response = await accept(
      client.connect({
        params: { type: "insforge" },
        body: {
          authMethod: "api-token",
          values: {
            apiKey: "ik_test-key",
            domain: "https://9ksx253h.us-west.insforge.app/api/",
          },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      type: "insforge",
      authMethod: "api-token",
      connectionStatus: "connected",
    });
    const stored = await readConnector(fixture, "insforge");
    expect(stored.body.authMethod).toBe("api-token");
  });

  it("connects Lark app credentials through the API", async () => {
    const fixture = await seedFixture();
    const client = setupApp({ context })(zeroConnectorManualGrantContract);

    const response = await accept(
      client.connect({
        params: { type: "lark" },
        body: {
          authMethod: "api-token",
          values: {
            appId: " cli_a123 ",
            appSecret: " lark-app-secret\n",
          },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      type: "lark",
      authMethod: "api-token",
      connectionStatus: "connected",
      reconnectReason: null,
      tokenExpiresAt: null,
    });
    const stored = await readConnector(fixture, "lark");
    expect(stored.body.connectionStatus).toBe("connected");
  });

  it("reconnects Lark manual grant state through the API", async () => {
    const fixture = await seedFixture();
    const client = setupApp({ context })(zeroConnectorManualGrantContract);
    await accept(
      client.connect({
        params: { type: "lark" },
        body: {
          authMethod: "api-token",
          values: {
            appId: "cli_old",
            appSecret: "old-lark-app-secret",
          },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    await accept(
      client.connect({
        params: { type: "lark" },
        body: {
          authMethod: "api-token",
          values: {
            appId: "cli_new",
            appSecret: "new-lark-app-secret",
          },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const stored = await readConnector(fixture, "lark");
    expect(stored.body).toMatchObject({
      authMethod: "api-token",
      connectionStatus: "connected",
      reconnectReason: null,
      tokenExpiresAt: null,
    });
  });

  it("replaces stored manual grant state with new manual grant state", async () => {
    const fixture = await seedFixture();
    await updateFeatureSwitches(fixture, {
      [FeatureSwitchKey.TestOauthConnector]: true,
    });
    const client = setupApp({ context })(zeroConnectorManualGrantContract);
    await accept(
      client.connect({
        params: { type: "test-oauth" },
        body: {
          authMethod: "api-token",
          values: {
            apiToken: "old-manual-test-oauth-token",
            inputVariable: "old-input-variable",
            tenantId: "old-tenant",
          },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    await accept(
      client.connect({
        params: { type: "test-oauth" },
        body: {
          authMethod: "api-token",
          values: {
            apiToken: "manual-test-oauth-token",
            inputVariable: "manual-input-variable",
            tenantId: "manual-tenant",
          },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const getResponse = await readConnector(fixture, "test-oauth");
    expect(getResponse.body.authMethod).toBe("api-token");
  });

  it("replaces GitLab manual grant when optional fields are omitted", async () => {
    const fixture = await seedFixture();
    const client = setupApp({ context })(zeroConnectorManualGrantContract);
    await accept(
      client.connect({
        params: { type: "gitlab" },
        body: {
          authMethod: "api-token",
          values: {
            accessToken: "old-token",
            host: "gitlab.example.com",
          },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    await accept(
      client.connect({
        params: { type: "gitlab" },
        body: {
          authMethod: "api-token",
          values: { accessToken: "new-token" },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const stored = await readConnector(fixture, "gitlab");
    expect(stored.body).toMatchObject({
      type: "gitlab",
      authMethod: "api-token",
      connectionStatus: "connected",
    });
  });

  it("rejects private field names and identifies the public field id", async () => {
    await seedFixture();
    const client = setupApp({ context })(zeroConnectorManualGrantContract);

    const response = await accept(
      client.connect({
        params: { type: "openai" },
        body: {
          authMethod: "api-token",
          values: { OPENAI_TOKEN: "sk-private" },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body.error.message).toContain("apiKey");
    expect(response.body.error.message).not.toContain("OPENAI_TOKEN");
    expect(response.body.error.message).not.toContain("sk-private");
  });

  it("rejects unknown public fields without echoing submitted values", async () => {
    await seedFixture();
    const client = setupApp({ context })(zeroConnectorManualGrantContract);

    const response = await accept(
      client.connect({
        params: { type: "openai" },
        body: {
          authMethod: "api-token",
          values: {
            apiKey: "sk-test",
            unknownField: "secret-value-should-not-echo",
          },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body.error.message).toContain("apiKey");
    expect(response.body.error.message).not.toContain("unknownField");
    expect(response.body.error.message).not.toContain(
      "secret-value-should-not-echo",
    );
  });

  it("rejects missing required fields", async () => {
    await seedFixture();
    const client = setupApp({ context })(zeroConnectorManualGrantContract);

    const response = await accept(
      client.connect({
        params: { type: "openai" },
        body: { authMethod: "api-token", values: {} },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body.error.message).toContain("apiKey");
    expect(response.body.error.message).not.toContain("OPENAI_TOKEN");
  });

  it("rejects required fields that sanitize to empty without private field names", async () => {
    await seedFixture();
    const client = setupApp({ context })(zeroConnectorManualGrantContract);

    const response = await accept(
      client.connect({
        params: { type: "openai" },
        body: { authMethod: "api-token", values: { apiKey: " \n\t " } },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body.error.message).toContain("apiKey");
    expect(response.body.error.message).not.toContain("OPENAI_TOKEN");
  });

  it("rejects connectors that do not support manual grant auth", async () => {
    await seedFixture();
    const client = setupApp({ context })(zeroConnectorManualGrantContract);

    const response = await accept(
      client.connect({
        params: { type: "github" },
        body: { authMethod: "api-token", values: {} },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body.error.message).toContain(
      "github connector does not have api-token auth method",
    );
  });

  it("rejects selected auth methods without manual grants", async () => {
    await seedFixture();
    const client = setupApp({ context })(zeroConnectorManualGrantContract);

    const response = await accept(
      client.connect({
        params: { type: "stripe" },
        body: { authMethod: "oauth", values: { apiKey: "sk_test_key" } },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body.error.message).toContain(
      "stripe oauth auth method does not use a manual grant",
    );
  });

  it("allows feature-gated manual grant auth outside discovery", async () => {
    await seedFixture();
    const client = setupApp({ context })(zeroConnectorManualGrantContract);

    const response = await accept(
      client.connect({
        params: { type: "bentoml" },
        body: {
          authMethod: "api-token",
          values: {
            apiToken: "bento-token",
            endpoint: "https://example.bentoml.test",
          },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      type: "bentoml",
      authMethod: "api-token",
      connectionStatus: "connected",
    });
  });

  it("rejects authored-hidden manual grant auth", async () => {
    await seedFixture();
    const client = setupApp({ context })(zeroConnectorManualGrantContract);

    const response = await accept(
      client.connect({
        params: { type: "cloudflare" },
        body: { authMethod: "api-token", values: {} },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [403],
    );

    expect(response.body.error).toStrictEqual({
      message: "cloudflare connector is not available",
      code: "FORBIDDEN",
    });
  });

  it("publishes one connector change event on successful replacement", async () => {
    await seedFixture();
    context.mocks.ably.publish.mockClear();
    const client = setupApp({ context })(zeroConnectorManualGrantContract);

    await accept(
      client.connect({
        params: { type: "openai" },
        body: { authMethod: "api-token", values: { apiKey: "sk-test" } },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(1);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "connector:changed",
      { connectorRef: "openai" },
    );
  });

  it("allows feature-gated manual grant auth when enabled", async () => {
    const fixture = await seedFixture();
    await updateFeatureSwitches(fixture, {
      [FeatureSwitchKey.BentomlConnector]: true,
    });
    const client = setupApp({ context })(zeroConnectorManualGrantContract);

    const response = await accept(
      client.connect({
        params: { type: "bentoml" },
        body: {
          authMethod: "api-token",
          values: {
            apiToken: "bento-token",
            endpoint: "https://example.bentoml.test",
          },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      type: "bentoml",
      authMethod: "api-token",
    });
  });
});
