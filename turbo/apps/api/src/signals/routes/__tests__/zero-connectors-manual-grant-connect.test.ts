import { randomUUID } from "node:crypto";

import {
  zeroConnectorManualGrantContract,
  zeroConnectorsByTypeContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { connectors } from "@vm0/db/schema/connector";
import { secrets } from "@vm0/db/schema/secret";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { variables } from "@vm0/db/schema/variable";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { afterEach } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
import { writeDb$ } from "../../external/db";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
  type OrgMembershipFixture,
} from "./helpers/zero-org-membership";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

async function seedAuthenticatedFixture(): Promise<OrgMembershipFixture> {
  const fixture = await store.set(
    seedOrgMembership$,
    {
      orgId: `org_${randomUUID()}`,
      userId: `user_${randomUUID()}`,
    },
    context.signal,
  );
  mocks.clerk.session(fixture.userId, fixture.orgId);
  return fixture;
}

async function cleanupFixture(fixture: OrgMembershipFixture): Promise<void> {
  const db = store.set(writeDb$);
  await db.delete(connectors).where(eq(connectors.orgId, fixture.orgId));
  await db.delete(secrets).where(eq(secrets.orgId, fixture.orgId));
  await db.delete(variables).where(eq(variables.orgId, fixture.orgId));
  await db
    .delete(userFeatureSwitches)
    .where(eq(userFeatureSwitches.orgId, fixture.orgId));
  await store.set(deleteOrgMembership$, fixture, context.signal);
}

async function connectorRows(fixture: OrgMembershipFixture, type: string) {
  const db = store.set(writeDb$);
  return await db
    .select()
    .from(connectors)
    .where(
      and(
        eq(connectors.orgId, fixture.orgId),
        eq(connectors.userId, fixture.userId),
        eq(connectors.type, type),
      ),
    );
}

async function secretRows(
  fixture: OrgMembershipFixture,
  name: string,
  type: "connector" | "user",
) {
  const db = store.set(writeDb$);
  return await db
    .select()
    .from(secrets)
    .where(
      and(
        eq(secrets.orgId, fixture.orgId),
        eq(secrets.userId, fixture.userId),
        eq(secrets.name, name),
        eq(secrets.type, type),
      ),
    );
}

async function variableRows(fixture: OrgMembershipFixture, name: string) {
  const db = store.set(writeDb$);
  return await db
    .select()
    .from(variables)
    .where(
      and(
        eq(variables.orgId, fixture.orgId),
        eq(variables.userId, fixture.userId),
        eq(variables.name, name),
      ),
    );
}

describe("POST /api/zero/connectors/:type/manual-grant", () => {
  const fixtures: OrgMembershipFixture[] = [];

  afterEach(async () => {
    while (fixtures.length > 0) {
      const fixture = fixtures.pop();
      if (fixture) {
        await cleanupFixture(fixture);
      }
    }
  });

  async function seedFixture(): Promise<OrgMembershipFixture> {
    const fixture = await seedAuthenticatedFixture();
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
    await expect(connectorRows(fixture, "openai")).resolves.toHaveLength(1);
    await expect(
      secretRows(fixture, "OPENAI_TOKEN", "connector"),
    ).resolves.toHaveLength(1);
    await expect(
      secretRows(fixture, "OPENAI_TOKEN", "user"),
    ).resolves.toHaveLength(0);
  });

  it("stores Zendesk manual grant fields as one connector secret and two connector variables", async () => {
    const fixture = await seedFixture();
    const client = setupApp({ context })(zeroConnectorManualGrantContract);

    await accept(
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

    await expect(
      secretRows(fixture, "ZENDESK_API_TOKEN", "connector"),
    ).resolves.toHaveLength(1);
    await expect(variableRows(fixture, "ZENDESK_EMAIL")).resolves.toMatchObject(
      [{ value: "support@example.com", type: "connector" }],
    );
    await expect(
      variableRows(fixture, "ZENDESK_SUBDOMAIN"),
    ).resolves.toMatchObject([{ value: "example", type: "connector" }]);
  });

  it("stores Lark app credentials without writing the logical access token", async () => {
    const fixture = await seedFixture();
    const db = store.set(writeDb$);
    await db.insert(userFeatureSwitches).values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      switches: { [FeatureSwitchKey.LarkConnector]: true },
    });
    const client = setupApp({ context })(zeroConnectorManualGrantContract);

    await accept(
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

    await expect(connectorRows(fixture, "lark")).resolves.toMatchObject([
      {
        authMethod: "api-token",
        tokenExpiresAt: null,
        needsReconnect: false,
      },
    ]);
    await expect(
      secretRows(fixture, "LARK_APP_SECRET", "connector"),
    ).resolves.toHaveLength(1);
    await expect(
      secretRows(fixture, "LARK_ACCESS_TOKEN", "connector"),
    ).resolves.toHaveLength(0);
    await expect(
      secretRows(fixture, "LARK_TOKEN", "connector"),
    ).resolves.toHaveLength(0);
    await expect(
      secretRows(fixture, "LARK_TOKEN", "user"),
    ).resolves.toHaveLength(0);
    await expect(variableRows(fixture, "LARK_APP_ID")).resolves.toMatchObject([
      { value: "cli_a123", type: "connector" },
    ]);
  });

  it("clears stale Lark access token state on reconnect", async () => {
    const fixture = await seedFixture();
    const db = store.set(writeDb$);
    await db.insert(userFeatureSwitches).values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      switches: { [FeatureSwitchKey.LarkConnector]: true },
    });
    await db.insert(connectors).values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      type: "lark",
      authMethod: "api-token",
      tokenExpiresAt: new Date("2030-01-01T00:00:00Z"),
      needsReconnect: true,
    });
    await db.insert(secrets).values([
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        name: "LARK_TOKEN",
        encryptedValue: "encrypted_legacy_lark_token",
        type: "connector",
      },
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        name: "LARK_ACCESS_TOKEN",
        encryptedValue: "encrypted_stale_lark_access_token",
        type: "connector",
      },
    ]);

    const client = setupApp({ context })(zeroConnectorManualGrantContract);
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

    await expect(connectorRows(fixture, "lark")).resolves.toMatchObject([
      {
        authMethod: "api-token",
        tokenExpiresAt: null,
        needsReconnect: false,
      },
    ]);
    await expect(
      secretRows(fixture, "LARK_ACCESS_TOKEN", "connector"),
    ).resolves.toHaveLength(0);
    await expect(
      secretRows(fixture, "LARK_APP_SECRET", "connector"),
    ).resolves.toHaveLength(1);
    await expect(
      secretRows(fixture, "LARK_TOKEN", "connector"),
    ).resolves.toHaveLength(1);
  });

  it("replaces stored OAuth state with stored manual grant state", async () => {
    const fixture = await seedFixture();
    const db = store.set(writeDb$);
    await db.insert(connectors).values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      type: "stripe",
      authMethod: "oauth",
    });
    await db.insert(secrets).values([
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        name: "STRIPE_ACCESS_TOKEN",
        encryptedValue: "encrypted_stripe_access_token",
        type: "connector",
      },
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        name: "STRIPE_REFRESH_TOKEN",
        encryptedValue: "encrypted_stripe_refresh_token",
        type: "connector",
      },
    ]);

    const client = setupApp({ context })(zeroConnectorManualGrantContract);
    await accept(
      client.connect({
        params: { type: "stripe" },
        body: {
          authMethod: "api-token",
          values: { STRIPE_TOKEN: "sk_test_key" },
        },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    await expect(connectorRows(fixture, "stripe")).resolves.toMatchObject([
      { authMethod: "api-token" },
    ]);
    await expect(
      secretRows(fixture, "STRIPE_ACCESS_TOKEN", "connector"),
    ).resolves.toHaveLength(0);
    await expect(
      secretRows(fixture, "STRIPE_REFRESH_TOKEN", "connector"),
    ).resolves.toHaveLength(0);
    await expect(
      secretRows(fixture, "STRIPE_TOKEN", "connector"),
    ).resolves.toHaveLength(1);
    await expect(
      secretRows(fixture, "STRIPE_TOKEN", "user"),
    ).resolves.toHaveLength(0);

    const getClient = setupApp({ context })(zeroConnectorsByTypeContract);
    const getResponse = await accept(
      getClient.get({
        params: { type: "stripe" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(getResponse.body.authMethod).toBe("api-token");
  });

  it("deletes omitted optional manual grant fields on replacement", async () => {
    const fixture = await seedFixture();
    const db = store.set(writeDb$);
    await db.insert(connectors).values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      type: "gitlab",
      authMethod: "api-token",
    });
    await db.insert(secrets).values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      name: "GITLAB_TOKEN",
      encryptedValue: "encrypted_gitlab_token",
      type: "connector",
    });
    await db.insert(variables).values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      name: "GITLAB_HOST",
      value: "gitlab.example.com",
      type: "connector",
    });

    const client = setupApp({ context })(zeroConnectorManualGrantContract);
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

    await expect(
      secretRows(fixture, "GITLAB_TOKEN", "connector"),
    ).resolves.toHaveLength(1);
    await expect(variableRows(fixture, "GITLAB_HOST")).resolves.toHaveLength(0);
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
    const db = store.set(writeDb$);
    await db.insert(userFeatureSwitches).values({
      orgId: fixture.orgId,
      userId: fixture.userId,
      switches: { [FeatureSwitchKey.BentomlConnector]: true },
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
