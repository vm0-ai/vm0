import { randomUUID } from "node:crypto";

import {
  zeroConnectorManualGrantContract,
  zeroConnectorsByTypeContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { afterEach } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

interface AuthenticatedFixture {
  readonly orgId: string;
  readonly userId: string;
}

const CONNECTOR_TYPES_TO_CLEAN_UP = [
  "openai",
  "zendesk",
  "insforge",
  "lark",
  "test-oauth",
  "gitlab",
  "bentoml",
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
  type: (typeof CONNECTOR_TYPES_TO_CLEAN_UP)[number],
): Promise<void> {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  await accept(
    setupApp({ context })(zeroConnectorsByTypeContract).delete({
      params: { type },
      headers: authHeaders(),
    }),
    [204, 404],
  );
}

async function cleanupFixture(fixture: AuthenticatedFixture): Promise<void> {
  await deleteFeatureSwitches(fixture);
  for (const type of CONNECTOR_TYPES_TO_CLEAN_UP) {
    await deleteConnector(fixture, type);
  }
}

async function readConnector(
  fixture: AuthenticatedFixture,
  type: (typeof CONNECTOR_TYPES_TO_CLEAN_UP)[number],
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
        body: { authMethod: "api-token", values: { OPENAI_TOKEN: "sk-test" } },
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
        body: { authMethod: "api-token", values: { OPENAI_TOKEN: "sk-test" } },
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
        body: JSON.stringify({ values: { OPENAI_TOKEN: "sk-test" } }),
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
          values: { OPENAI_TOKEN: " sk-test\n" },
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

  it("connects a first-time manual grant connector using public field ids", async () => {
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
      connectionStatus: "connected",
    });
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
            ZENDESK_API_TOKEN: " zendesk\n-token ",
            ZENDESK_EMAIL: " support@example.com ",
            ZENDESK_SUBDOMAIN: " example ",
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
  });

  it("connects Zendesk manual grant fields using public field ids", async () => {
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
  });

  it("accepts a full URL host field for manual grant connectors", async () => {
    const fixture = await seedFixture();
    const client = setupApp({ context })(zeroConnectorManualGrantContract);

    const response = await accept(
      client.connect({
        params: { type: "insforge" },
        body: {
          authMethod: "api-token",
          values: {
            INSFORGE_API_KEY: "ik_test-key",
            INSFORGE_DOMAIN: "https://9ksx253h.us-west.insforge.app/api/",
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

  it("normalizes host fields submitted with public field ids", async () => {
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
            LARK_APP_ID: " cli_a123 ",
            LARK_APP_SECRET: " lark-app-secret\n",
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

  it("connects Lark secret and variable fields using public field ids", async () => {
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
            LARK_APP_ID: "cli_old",
            LARK_APP_SECRET: "old-lark-app-secret",
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
            LARK_APP_ID: "cli_new",
            LARK_APP_SECRET: "new-lark-app-secret",
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
            TEST_OAUTH_TOKEN: "old-manual-test-oauth-token",
            TEST_OAUTH_API_TOKEN_INPUT_VAR: "old-input-variable",
            TEST_OAUTH_API_TENANT_ID: "old-tenant",
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
            TEST_OAUTH_TOKEN: "manual-test-oauth-token",
            TEST_OAUTH_API_TOKEN_INPUT_VAR: "manual-input-variable",
            TEST_OAUTH_API_TENANT_ID: "manual-tenant",
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
            GITLAB_TOKEN: "old-token",
            GITLAB_HOST: "gitlab.example.com",
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
          values: { GITLAB_TOKEN: "new-token" },
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

  it("replaces GitLab manual grant using public field ids when optional fields are omitted", async () => {
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

  it("rejects ambiguous public and legacy keys for the same field", async () => {
    await seedFixture();
    const client = setupApp({ context })(zeroConnectorManualGrantContract);

    const response = await accept(
      client.connect({
        params: { type: "openai" },
        body: {
          authMethod: "api-token",
          values: {
            apiKey: "sk-public",
            OPENAI_TOKEN: "sk-legacy",
          },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body.error.message).toContain("apiKey");
    expect(response.body.error.message).not.toContain("sk-public");
    expect(response.body.error.message).not.toContain("sk-legacy");
  });

  it("rejects unknown fields without echoing submitted values", async () => {
    await seedFixture();
    const client = setupApp({ context })(zeroConnectorManualGrantContract);

    const response = await accept(
      client.connect({
        params: { type: "openai" },
        body: {
          authMethod: "api-token",
          values: {
            OPENAI_TOKEN: "sk-test",
            EXTRA_TOKEN: "secret-value-should-not-echo",
          },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body.error.message).toContain("EXTRA_TOKEN");
    expect(response.body.error.message).not.toContain(
      "secret-value-should-not-echo",
    );
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

    expect(response.body.error.message).toContain("unknownField");
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

    expect(response.body.error.message).toContain("OPENAI_TOKEN");
  });

  it("rejects required fields that sanitize to empty", async () => {
    await seedFixture();
    const client = setupApp({ context })(zeroConnectorManualGrantContract);

    const response = await accept(
      client.connect({
        params: { type: "openai" },
        body: { authMethod: "api-token", values: { OPENAI_TOKEN: " \n\t " } },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body.error.message).toContain("OPENAI_TOKEN");
  });

  it("rejects public required fields that sanitize to empty without private field names", async () => {
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
        body: { authMethod: "oauth", values: { STRIPE_TOKEN: "sk_test_key" } },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [400],
    );

    expect(response.body.error.message).toContain(
      "stripe oauth auth method does not use a manual grant",
    );
  });

  it("rejects feature-gated manual grant auth when unavailable", async () => {
    await seedFixture();
    const client = setupApp({ context })(zeroConnectorManualGrantContract);

    const response = await accept(
      client.connect({
        params: { type: "bentoml" },
        body: {
          authMethod: "api-token",
          values: {
            BENTO_CLOUD_API_KEY: "bento-token",
            BENTO_CLOUD_API_ENDPOINT: "https://example.bentoml.test",
          },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [403],
    );

    expect(response.body.error.code).toBe("FORBIDDEN");
  });

  it("publishes one connector change event on successful replacement", async () => {
    await seedFixture();
    context.mocks.ably.publish.mockClear();
    const client = setupApp({ context })(zeroConnectorManualGrantContract);

    await accept(
      client.connect({
        params: { type: "openai" },
        body: { authMethod: "api-token", values: { OPENAI_TOKEN: "sk-test" } },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(1);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "connector:changed",
      null,
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
            BENTO_CLOUD_API_KEY: "bento-token",
            BENTO_CLOUD_API_ENDPOINT: "https://example.bentoml.test",
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
