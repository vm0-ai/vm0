import { randomUUID } from "node:crypto";

import { zeroConnectorCatalogContract } from "@vm0/api-contracts/contracts/zero-connector-catalog";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { userFeatureSwitches } from "@vm0/db/schema/user-feature-switches";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { afterEach } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
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
  const writeDb = store.set(writeDb$);
  await writeDb.insert(userFeatureSwitches).values({
    orgId,
    userId,
    switches,
  });
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
    const writeDb = store.set(writeDb$);
    while (seededFeatureSwitches.length > 0) {
      const fixture = seededFeatureSwitches.pop();
      if (fixture) {
        await writeDb
          .delete(userFeatureSwitches)
          .where(
            and(
              eq(userFeatureSwitches.orgId, fixture.orgId),
              eq(userFeatureSwitches.userId, fixture.userId),
            ),
          );
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
