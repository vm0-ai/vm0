import { randomUUID } from "node:crypto";

import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import {
  zeroConnectorManualGrantContract,
  zeroConnectorsBySlugContract,
} from "@okouai/api-contracts/contracts/zero-connectors";
import { zeroFeatureSwitchesContract } from "@okouai/api-contracts/contracts/zero-feature-switches";
import {
  zeroCustomConnectorByIdContract,
  zeroCustomConnectorConnectionContract,
  zeroCustomConnectorValuesContract,
  zeroCustomConnectorsContract,
  type CreateCustomConnectorBody,
} from "@okouai/api-contracts/contracts/zero-custom-connectors";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { connectorAccountRoutes } from "../connector-accounts";
import { connectorsRoutes } from "../connectors";
import { customConnectorsRoutes } from "../custom-connectors";
import { customConnectorsDeleteRoutes } from "../custom-connectors-delete";
import { customConnectorDisconnectRoutes } from "../custom-connectors-disconnect";
import { customConnectorsValuesSetRoutes } from "../custom-connectors-values-set";
import { featureSwitchesRoutes } from "../feature-switches";
import { seedConnectorStorageRow } from "./helpers/connector-credential-storage-state";
import { createFixtureTracker, createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const routes = Object.freeze([
  ...connectorAccountRoutes,
  ...connectorsRoutes,
  ...customConnectorsRoutes,
  ...customConnectorsDeleteRoutes,
  ...customConnectorDisconnectRoutes,
  ...customConnectorsValuesSetRoutes,
  ...featureSwitchesRoutes,
]);

interface Fixture {
  readonly orgId: string;
  readonly userId: string;
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function accountClient() {
  return setupApp({ context, routes })(connectorAccountsContract);
}

function connectorClient() {
  return setupApp({ context, routes })(zeroConnectorManualGrantContract);
}

function legacyConnectorClient() {
  return setupApp({ context, routes })(zeroConnectorsBySlugContract);
}

function featureClient() {
  return setupApp({ context, routes })(zeroFeatureSwitchesContract);
}

function customConnectorClient() {
  return setupApp({ context, routes })(zeroCustomConnectorsContract);
}

function customConnectorByIdClient() {
  return setupApp({ context, routes })(zeroCustomConnectorByIdContract);
}

function customConnectorValuesClient() {
  return setupApp({ context, routes })(zeroCustomConnectorValuesContract);
}

function customConnectorConnectionClient() {
  return setupApp({ context, routes })(zeroCustomConnectorConnectionContract);
}

async function setConnectorAccountsEnabled(
  fixture: Fixture,
  enabled: boolean,
): Promise<void> {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  await accept(
    featureClient().update({
      headers: authHeaders(),
      body: {
        switches: { [FeatureSwitchKey.ConnectorAccounts]: enabled },
      },
    }),
    [200],
  );
}

async function cleanupFixture(fixture: Fixture): Promise<void> {
  mocks.clerk.session(fixture.userId, fixture.orgId);
  let hasBuiltinAccounts = true;
  while (hasBuiltinAccounts) {
    const accounts = await accept(
      accountClient().connections({
        headers: authHeaders(),
        query: { kind: "builtin", connectorSlug: "openai", limit: 100 },
      }),
      [200, 404],
    );
    hasBuiltinAccounts =
      accounts.status === 200 && accounts.body.connections.length > 0;
    if (accounts.status !== 200) {
      break;
    }
    for (const account of accounts.body.connections) {
      await accept(
        accountClient().delete({
          headers: authHeaders(),
          params: { connectionId: account.id },
          body: {
            target: { kind: "builtin", connectorSlug: "openai" },
            selectionResolution: { kind: "clear" },
          },
        }),
        [200, 404],
      );
    }
  }
  const customConnectors = await accept(
    customConnectorClient().list({ headers: authHeaders() }),
    [200],
  );
  for (const definition of customConnectors.body.connectors) {
    const customAccounts = await accept(
      accountClient().connections({
        headers: authHeaders(),
        query: {
          kind: "custom",
          customConnectorId: definition.id,
          limit: 100,
        },
      }),
      [200, 404],
    );
    if (customAccounts.status === 200) {
      for (const account of customAccounts.body.connections) {
        await accept(
          accountClient().delete({
            headers: authHeaders(),
            params: { connectionId: account.id },
            body: {
              target: {
                kind: "custom",
                customConnectorId: definition.id,
              },
              selectionResolution: { kind: "clear" },
            },
          }),
          [200, 404],
        );
      }
    }
    await accept(
      customConnectorByIdClient().delete({
        headers: authHeaders(),
        params: { id: definition.id },
      }),
      [204, 404],
    );
  }
  await accept(featureClient().delete({ headers: authHeaders() }), [200]);
}

describe("connector account lifecycle routes", () => {
  const track = createFixtureTracker<Fixture>(cleanupFixture);

  async function seedFixture(): Promise<Fixture> {
    const fixture = await track(
      Promise.resolve({
        orgId: `org_${randomUUID()}`,
        userId: `user_${randomUUID()}`,
      }),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    return fixture;
  }

  it("hides canonical account resources while the feature is disabled", async () => {
    await seedFixture();
    const response = await accept(
      accountClient().summaries({ headers: authHeaders() }),
      [404],
    );

    expect(response.body.error.message).toBe("Resource not found");
  });

  it("adds siblings and manages exact default and deletion lifecycle", async () => {
    const fixture = await seedFixture();
    await setConnectorAccountsEnabled(fixture, true);

    const first = await accept(
      connectorClient().connect({
        headers: authHeaders(),
        params: { connectorSlug: "openai" },
        body: {
          authMethod: "api-token",
          account: { intent: "add", displayName: "Work" },
          values: { apiKey: "sk-work" },
        },
      }),
      [200],
    );
    const second = await accept(
      connectorClient().connect({
        headers: authHeaders(),
        params: { connectorSlug: "openai" },
        body: {
          authMethod: "api-token",
          account: { intent: "add", displayName: "Personal" },
          values: { apiKey: "sk-personal" },
        },
      }),
      [200],
    );
    expect(second.body.id).not.toBe(first.body.id);

    const listed = await accept(
      accountClient().connections({
        headers: authHeaders(),
        query: { kind: "builtin", connectorSlug: "openai", limit: 1 },
      }),
      [200],
    );
    expect(listed.body.connections).toHaveLength(1);
    expect(listed.body.nextCursor).not.toBeNull();

    const next = await accept(
      accountClient().connections({
        headers: authHeaders(),
        query: {
          kind: "builtin",
          connectorSlug: "openai",
          limit: 1,
          cursor: listed.body.nextCursor!,
        },
      }),
      [200],
    );
    expect(next.body.connections).toHaveLength(1);
    expect(
      new Set([listed.body.connections[0]!.id, next.body.connections[0]!.id]),
    ).toStrictEqual(new Set([first.body.id, second.body.id]));

    const renamed = await accept(
      accountClient().rename({
        headers: authHeaders(),
        params: { connectionId: second.body.id },
        body: {
          target: { kind: "builtin", connectorSlug: "openai" },
          displayName: "Personal renamed",
        },
      }),
      [200],
    );
    expect(renamed.body.displayName).toBe("Personal renamed");

    const selectedDefault = await accept(
      accountClient().setDefault({
        headers: authHeaders(),
        params: { connectionId: second.body.id },
        body: { target: { kind: "builtin", connectorSlug: "openai" } },
      }),
      [200],
    );
    expect(selectedDefault.body.isDefault).toBeTruthy();

    const legacyProjection = await accept(
      legacyConnectorClient().get({
        headers: authHeaders(),
        params: { connectorSlug: "openai" },
      }),
      [200],
    );
    expect(legacyProjection.body.id).toBe(second.body.id);

    const summary = await accept(
      accountClient().summaries({ headers: authHeaders() }),
      [200],
    );
    expect(summary.body.summaries).toContainEqual(
      expect.objectContaining({
        target: { kind: "builtin", connectorSlug: "openai" },
        accountCount: 2,
        attentionCount: 0,
        defaultConnection: expect.objectContaining({ id: second.body.id }),
      }),
    );

    const impact = await accept(
      accountClient().deletionImpact({
        headers: authHeaders(),
        params: { connectionId: second.body.id },
        query: { kind: "builtin", connectorSlug: "openai" },
      }),
      [200],
    );
    expect(impact.body).toStrictEqual({
      connectionId: second.body.id,
      explicitSelectionCount: 0,
      hasSibling: true,
    });

    const invalidReplacement = await accept(
      accountClient().delete({
        headers: authHeaders(),
        params: { connectionId: second.body.id },
        body: {
          target: { kind: "builtin", connectorSlug: "openai" },
          selectionResolution: {
            kind: "reassign",
            connectionId: randomUUID(),
          },
        },
      }),
      [409],
    );
    expect(invalidReplacement.body.error.message).toBe(
      "Replacement connector account is not available",
    );

    const deleted = await accept(
      accountClient().delete({
        headers: authHeaders(),
        params: { connectionId: second.body.id },
        body: {
          target: { kind: "builtin", connectorSlug: "openai" },
          selectionResolution: { kind: "clear" },
        },
      }),
      [200],
    );
    expect(deleted.body).toStrictEqual({
      deletedConnectionId: second.body.id,
      resolvedSelectionCount: 0,
      promotedDefaultConnectionId: first.body.id,
    });

    const remaining = await accept(
      accountClient().connections({
        headers: authHeaders(),
        query: {
          kind: "builtin",
          connectorSlug: "openai",
          limit: 100,
          search: "Work",
        },
      }),
      [200],
    );
    expect(remaining.body.connections).toHaveLength(1);
    expect(remaining.body.connections[0]).toMatchObject({
      id: first.body.id,
      displayName: "Work",
      isDefault: true,
    });
  });

  it("keeps concurrent sibling creation to exactly one default", async () => {
    const fixture = await seedFixture();
    await setConnectorAccountsEnabled(fixture, true);

    const responses = await Promise.all(
      ["Concurrent A", "Concurrent B"].map((displayName) => {
        return connectorClient().connect({
          headers: authHeaders(),
          params: { connectorSlug: "openai" },
          body: {
            authMethod: "api-token",
            account: { intent: "add", displayName },
            values: { apiKey: `sk-${displayName}` },
          },
        });
      }),
    );
    expect(
      responses.map((response) => {
        return response.status;
      }),
    ).toStrictEqual([200, 200]);
    const accounts = await accept(
      accountClient().connections({
        headers: authHeaders(),
        query: { kind: "builtin", connectorSlug: "openai", limit: 100 },
      }),
      [200],
    );
    expect(accounts.body.connections).toHaveLength(2);
    expect(
      accounts.body.connections.filter((account) => {
        return account.isDefault;
      }),
    ).toHaveLength(1);
  });

  it("paginates and searches more than one hundred accounts", async () => {
    const fixture = await seedFixture();
    await setConnectorAccountsEnabled(fixture, true);

    for (let index = 0; index < 101; index += 1) {
      const label = `Bulk ${index.toString().padStart(3, "0")}`;
      await accept(
        connectorClient().connect({
          headers: authHeaders(),
          params: { connectorSlug: "openai" },
          body: {
            authMethod: "api-token",
            account: { intent: "add", displayName: label },
            values: { apiKey: `sk-${label}` },
          },
        }),
        [200],
      );
    }

    const ids = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await accept(
        accountClient().connections({
          headers: authHeaders(),
          query: {
            kind: "builtin",
            connectorSlug: "openai",
            limit: 23,
            ...(cursor ? { cursor } : {}),
          },
        }),
        [200],
      );
      for (const account of page.body.connections) {
        ids.add(account.id);
      }
      cursor = page.body.nextCursor ?? undefined;
    } while (cursor);
    expect(ids.size).toBe(101);

    const searched = await accept(
      accountClient().connections({
        headers: authHeaders(),
        query: {
          kind: "builtin",
          connectorSlug: "openai",
          limit: 100,
          search: "Bulk 042",
        },
      }),
      [200],
    );
    expect(searched.body.connections).toHaveLength(1);
    expect(searched.body.connections[0]!.displayName).toBe("Bulk 042");

    const summary = await accept(
      accountClient().summaries({ headers: authHeaders() }),
      [200],
    );
    expect(summary.body.summaries).toContainEqual(
      expect.objectContaining({
        target: { kind: "builtin", connectorSlug: "openai" },
        accountCount: 101,
      }),
    );
  });

  it("does not enumerate or mutate another member account", async () => {
    const owner = await seedFixture();
    await setConnectorAccountsEnabled(owner, true);
    const account = await accept(
      connectorClient().connect({
        headers: authHeaders(),
        params: { connectorSlug: "openai" },
        body: {
          authMethod: "api-token",
          account: { intent: "add", displayName: "Owner" },
          values: { apiKey: "sk-owner" },
        },
      }),
      [200],
    );
    const other = await seedFixture();
    await setConnectorAccountsEnabled(other, true);
    mocks.clerk.session(other.userId, other.orgId);

    const listed = await accept(
      accountClient().connections({
        headers: authHeaders(),
        query: { kind: "builtin", connectorSlug: "openai", limit: 100 },
      }),
      [200],
    );
    expect(listed.body.connections).toStrictEqual([]);
    await accept(
      accountClient().rename({
        headers: authHeaders(),
        params: { connectionId: account.body.id },
        body: {
          target: { kind: "builtin", connectorSlug: "openai" },
          displayName: "Stolen",
        },
      }),
      [404],
    );
  });

  it("treats a removed built-in catalog target as absent", async () => {
    const fixture = await seedFixture();
    await setConnectorAccountsEnabled(fixture, true);
    const accountId = await seedConnectorStorageRow(context, {
      orgId: fixture.orgId,
      userId: fixture.userId,
      connectorSlug: "retired-connector",
      authMethod: "api-token",
      storageVersion: 1,
    });

    const summary = await accept(
      accountClient().summaries({ headers: authHeaders() }),
      [200],
    );
    expect(summary.body.summaries).not.toContainEqual(
      expect.objectContaining({
        target: { kind: "builtin", connectorSlug: "retired-connector" },
      }),
    );
    await accept(
      accountClient().connections({
        headers: authHeaders(),
        query: {
          kind: "builtin",
          connectorSlug: "retired-connector",
          limit: 100,
        },
      }),
      [404],
    );
    await accept(
      accountClient().rename({
        headers: authHeaders(),
        params: { connectionId: accountId },
        body: {
          target: { kind: "builtin", connectorSlug: "retired-connector" },
          displayName: "Must remain absent",
        },
      }),
      [404],
    );
  });

  it.each([
    {
      label: "HTTP",
      body: {
        displayName: "Account HTTP",
        prefixTemplates: ["https://api.example.com/"],
        fields: [
          {
            key: "secret",
            label: "Secret",
            kind: "secret" as const,
            required: true,
          },
        ],
        headerInjections: [
          {
            name: "Authorization",
            valueTemplate: "Bearer {{secrets.secret}}",
          },
        ],
        queryInjections: [],
      } satisfies CreateCustomConnectorBody,
    },
    {
      label: "MCP",
      body: {
        kind: "mcp" as const,
        displayName: "Account MCP",
        endpoint: "https://mcp.example.com/",
        transport: "streamable-http" as const,
        fields: [
          {
            key: "secret",
            label: "Secret",
            kind: "secret" as const,
            required: true,
          },
        ],
        headerInjections: [
          {
            name: "Authorization",
            valueTemplate: "Bearer {{secrets.secret}}",
          },
        ],
        queryInjections: [],
      } satisfies CreateCustomConnectorBody,
    },
  ])(
    "supports exact lifecycle for custom $label accounts",
    async ({ body }) => {
      const fixture = await seedFixture();
      mocks.clerk.session(fixture.userId, fixture.orgId);
      await accept(
        featureClient().update({
          headers: authHeaders(),
          body: {
            switches: {
              [FeatureSwitchKey.ConnectorAccounts]: true,
              [FeatureSwitchKey.CustomConnectorMcp]: true,
            },
          },
        }),
        [200],
      );
      const definition = await accept(
        customConnectorClient().create({ headers: authHeaders(), body }),
        [201],
      );

      for (const displayName of ["Work", "Personal"]) {
        await accept(
          customConnectorValuesClient().set({
            headers: authHeaders(),
            params: { id: definition.body.id },
            body: {
              values: [
                {
                  key: "secret",
                  kind: "secret",
                  value: `token-${displayName.toLowerCase()}`,
                },
              ],
              account: { intent: "add", displayName },
            },
          }),
          [200],
        );
      }

      const accounts = await accept(
        accountClient().connections({
          headers: authHeaders(),
          query: {
            kind: "custom",
            customConnectorId: definition.body.id,
            limit: 100,
          },
        }),
        [200],
      );
      expect(accounts.body.connections).toHaveLength(2);
      expect(
        accounts.body.connections.filter((account) => {
          return account.isDefault;
        }),
      ).toHaveLength(1);
      expect(
        accounts.body.connections
          .map((account) => {
            return account.displayName;
          })
          .sort(),
      ).toStrictEqual(["Personal", "Work"]);

      const legacyDisconnect = await accept(
        customConnectorConnectionClient().disconnect({
          headers: authHeaders(),
          params: { id: definition.body.id },
        }),
        [409],
      );
      expect(legacyDisconnect.body.error.message).toBe(
        "Multiple connector accounts require an exact choice",
      );

      const work = accounts.body.connections.find((account) => {
        return account.displayName === "Work";
      });
      const personal = accounts.body.connections.find((account) => {
        return account.displayName === "Personal";
      });
      if (!work || !personal) {
        throw new Error("Expected both custom connector accounts");
      }

      const renamed = await accept(
        accountClient().rename({
          headers: authHeaders(),
          params: { connectionId: personal.id },
          body: {
            target: {
              kind: "custom",
              customConnectorId: definition.body.id,
            },
            displayName: "Personal renamed",
          },
        }),
        [200],
      );
      expect(renamed.body.displayName).toBe("Personal renamed");

      await accept(
        accountClient().setDefault({
          headers: authHeaders(),
          params: { connectionId: personal.id },
          body: {
            target: {
              kind: "custom",
              customConnectorId: definition.body.id,
            },
          },
        }),
        [200],
      );
      const impact = await accept(
        accountClient().deletionImpact({
          headers: authHeaders(),
          params: { connectionId: personal.id },
          query: {
            kind: "custom",
            customConnectorId: definition.body.id,
          },
        }),
        [200],
      );
      expect(impact.body).toStrictEqual({
        connectionId: personal.id,
        explicitSelectionCount: 0,
        hasSibling: true,
      });

      const deleted = await accept(
        accountClient().delete({
          headers: authHeaders(),
          params: { connectionId: personal.id },
          body: {
            target: {
              kind: "custom",
              customConnectorId: definition.body.id,
            },
            selectionResolution: { kind: "clear" },
          },
        }),
        [200],
      );
      expect(deleted.body).toStrictEqual({
        deletedConnectionId: personal.id,
        resolvedSelectionCount: 0,
        promotedDefaultConnectionId: work.id,
      });

      const remaining = await accept(
        accountClient().connections({
          headers: authHeaders(),
          query: {
            kind: "custom",
            customConnectorId: definition.body.id,
            limit: 100,
          },
        }),
        [200],
      );
      expect(remaining.body.connections).toMatchObject([
        { id: work.id, displayName: "Work", isDefault: true },
      ]);
    },
  );
});
