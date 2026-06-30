import { randomUUID } from "node:crypto";

import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";
import { zeroConnectorCatalogContract } from "@vm0/api-contracts/contracts/zero-connector-catalog";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { createStore } from "ccstate";
import { afterEach } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
  type OrgMembershipFixture,
} from "./helpers/zero-org-membership";
import { createZeroRouteMocks } from "./helpers/zero-route-test";
import { assertPublicConnectorCatalogHasNoPrivateFields } from "./helpers/connector-catalog-public-leak";

const context = testContext();
const mocks = createZeroRouteMocks(context);
const store = createStore();

async function enableFeatureSwitches(
  orgId: string,
  userId: string,
  switches: Partial<Record<FeatureSwitchKey, boolean>>,
): Promise<void> {
  mocks.clerk.session(userId, orgId);
  const client = setupApp({ context })(zeroFeatureSwitchesContract);
  await accept(
    client.update({
      headers: { authorization: "Bearer clerk-session" },
      body: { switches },
    }),
    [200],
  );
}

async function deleteFeatureSwitches(
  orgId: string,
  userId: string,
): Promise<void> {
  mocks.clerk.session(userId, orgId);
  const client = setupApp({ context })(zeroFeatureSwitchesContract);
  await accept(
    client.delete({ headers: { authorization: "Bearer clerk-session" } }),
    [200],
  );
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

describe("GET /api/zero/connector-catalog", () => {
  const seededFeatureSwitches: {
    readonly orgId: string;
    readonly userId: string;
  }[] = [];
  const seededOrgs: OrgMembershipFixture[] = [];

  async function enablePublicCatalog(
    orgId: string,
    userId: string,
    switches: Partial<Record<FeatureSwitchKey, boolean>> = {},
  ): Promise<void> {
    seededFeatureSwitches.push({ orgId, userId });
    await enableFeatureSwitches(orgId, userId, {
      [FeatureSwitchKey.ConnectorCatalogApi]: true,
      ...switches,
    });
  }

  afterEach(async () => {
    while (seededFeatureSwitches.length > 0) {
      const fixture = seededFeatureSwitches.pop();
      if (fixture) {
        await deleteFeatureSwitches(fixture.orgId, fixture.userId);
      }
    }
    while (seededOrgs.length > 0) {
      const fixture = seededOrgs.pop();
      if (fixture) {
        await store.set(deleteOrgMembership$, fixture, context.signal);
      }
    }
  });

  it("returns 401 when not authenticated", async () => {
    const client = setupApp({ context })(zeroConnectorCatalogContract);
    const response = await accept(client.list({ headers: {} }), [401]);

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when the session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({ context })(zeroConnectorCatalogContract);
    const response = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 403 while the public catalog feature is disabled", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const client = setupApp({ context })(zeroConnectorCatalogContract);
    const response = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [403],
    );

    expect(response.body.error.message).toBe(
      "Connector catalog API is not enabled",
    );
  });

  it("returns compact public connector metadata when enabled", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    await enablePublicCatalog(orgId, userId);
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroConnectorCatalogContract);
    const response = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    assertPublicConnectorCatalogHasNoPrivateFields(response.body);
    expect(response.body.connectors.length).toBeGreaterThan(0);
    const openai = response.body.connectors.find((connector) => {
      return connector.connectorRef === "openai";
    });
    expect(openai).toBeDefined();
    expect(openai?.label).toBe("OpenAI");
    expect(openai?.generation).toContain("text");
    expect(openai?.tags).toContain("llm");
    expect(openai?.authMethods).toStrictEqual([
      {
        id: "api-token",
        label: "API Key",
        description: expect.any(String),
        grantKind: "manual",
      },
    ]);
    expect(openai?.permissionSummary).toStrictEqual({
      hasPermissions: false,
      permissionCount: 0,
      hasCategories: false,
      hasDefaultPolicyOverrides: false,
    });
    expect(openai?.permissionSummary).not.toHaveProperty("permissions");
  });

  it("accepts a ZERO_TOKEN carrying the connector:read capability", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    await enablePublicCatalog(orgId, userId);
    seededOrgs.push(
      await store.set(
        seedOrgMembership$,
        { orgId, userId, role: "admin" },
        context.signal,
      ),
    );
    const seconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "zero",
      userId,
      orgId,
      runId: `run_${randomUUID()}`,
      capabilities: ["connector:read"],
      iat: seconds,
      exp: seconds + 600,
    });

    const client = setupApp({ context })(zeroConnectorCatalogContract);
    const response = await accept(
      client.list({ headers: { authorization: `Bearer ${token}` } }),
      [200],
    );

    expect(response.body.connectors.length).toBeGreaterThan(0);
  });

  it("rejects a ZERO_TOKEN missing the connector:read capability with 403", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    await enablePublicCatalog(orgId, userId);
    seededOrgs.push(
      await store.set(
        seedOrgMembership$,
        { orgId, userId, role: "admin" },
        context.signal,
      ),
    );
    const seconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "zero",
      userId,
      orgId,
      runId: `run_${randomUUID()}`,
      capabilities: [],
      iat: seconds,
      exp: seconds + 600,
    });

    const client = setupApp({ context })(zeroConnectorCatalogContract);
    const response = await accept(
      client.list({ headers: { authorization: `Bearer ${token}` } }),
      [403],
    );

    expect(response.body.error.code).toBe("FORBIDDEN");
    expect(response.body.error.message).toBe(
      "Missing required capability: connector:read",
    );
  });

  it("returns connector detail without leaking manual field storage names", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    await enablePublicCatalog(orgId, userId);
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroConnectorCatalogContract);
    const response = await accept(
      client.get({
        params: { connectorRef: "openai" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    assertPublicConnectorCatalogHasNoPrivateFields(response.body);
    const apiToken = response.body.connector.authMethods.find((method) => {
      return method.id === "api-token";
    });
    expect(apiToken?.manualFields).toStrictEqual([
      {
        id: "field-1",
        label: "API Key",
        required: true,
        placeholder: "sk-...",
        inputType: "password",
      },
    ]);
  });

  it("omits auth text and placeholders derived from private names", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    await enablePublicCatalog(orgId, userId);
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroConnectorCatalogContract);
    const response = await accept(
      client.get({
        params: { connectorRef: "parallel" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    assertPublicConnectorCatalogHasNoPrivateFields(response.body);
    const apiToken = response.body.connector.authMethods.find((method) => {
      return method.id === "api-token";
    });
    expect(apiToken?.description).toBeNull();
    expect(apiToken?.manualFields).toStrictEqual([
      {
        id: "field-1",
        label: "API Key",
        required: true,
        placeholder: null,
        inputType: "password",
      },
    ]);
  });

  it("returns every visible connector detail without private metadata", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    await enablePublicCatalog(orgId, userId, {
      [FeatureSwitchKey.NeonConnector]: true,
    });
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroConnectorCatalogContract);
    const listResponse = await accept(
      client.list({ headers: { authorization: "Bearer clerk-session" } }),
      [200],
    );

    for (const connector of listResponse.body.connectors) {
      const detailResponse = await accept(
        client.get({
          params: { connectorRef: connector.connectorRef },
          headers: { authorization: "Bearer clerk-session" },
        }),
        [200],
      );
      assertPublicConnectorCatalogHasNoPrivateFields(detailResponse.body);
    }
  });

  it("returns 404 for hidden connector catalog refs", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    await enablePublicCatalog(orgId, userId);
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroConnectorCatalogContract);
    const response = await accept(
      client.get({
        params: { connectorRef: "test-oauth-device" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body.error.message).toBe(
      "Connector catalog item not found",
    );
  });

  it("hides feature-gated auth methods from connector detail", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    await enablePublicCatalog(orgId, userId);
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroConnectorCatalogContract);
    const response = await accept(
      client.get({
        params: { connectorRef: "neon" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    assertPublicConnectorCatalogHasNoPrivateFields(response.body);
    expect(
      response.body.connector.authMethods.map((authMethod) => {
        return authMethod.id;
      }),
    ).toStrictEqual(["api-token"]);
  });

  it("shows feature-gated auth methods when their connector feature is enabled", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    await enablePublicCatalog(orgId, userId, {
      [FeatureSwitchKey.NeonConnector]: true,
    });
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroConnectorCatalogContract);
    const response = await accept(
      client.get({
        params: { connectorRef: "neon" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    assertPublicConnectorCatalogHasNoPrivateFields(response.body);
    expect(
      response.body.connector.authMethods.map((authMethod) => {
        return authMethod.id;
      }),
    ).toStrictEqual(["oauth", "api-token"]);
  });

  it("returns public permission detail without firewall execution metadata", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    await enablePublicCatalog(orgId, userId);
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroConnectorCatalogContract);
    const response = await accept(
      client.permissions({
        params: { connectorRef: "google-docs" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    assertPublicConnectorCatalogHasNoPrivateFields(response.body);
    expect(response.body.permissions.connectorRef).toBe("google-docs");
    expect(response.body.permissions.permissionCount).toBeGreaterThan(0);
    expect(response.body.permissions.permissions).toHaveLength(
      response.body.permissions.permissionCount,
    );
    expect(response.body.permissions.permissions[0]).not.toHaveProperty(
      "rules",
    );
  });
});
