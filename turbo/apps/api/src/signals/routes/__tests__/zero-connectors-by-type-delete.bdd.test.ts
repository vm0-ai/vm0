import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  zeroConnectorManualGrantContract,
  zeroConnectorsByTypeContract,
  zeroConnectorsMainContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import {
  zeroSecretsByNameContract,
  zeroSecretsContract,
  zeroVariablesByNameContract,
  zeroVariablesContract,
} from "@vm0/api-contracts/contracts/zero-secrets";
import type { ConnectorType } from "@vm0/connectors/connectors";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const mocks = createZeroRouteMocks(context);

interface Actor {
  readonly orgId: string;
  readonly userId: string;
}

interface ActorConnector {
  readonly actor: Actor;
  readonly type: ConnectorType;
}

interface NamedUserResource {
  readonly actor: Actor;
  readonly name: string;
}

function actor(prefix: string): Actor {
  const suffix = randomUUID().slice(0, 8);
  return {
    orgId: `org_${prefix}_${suffix}`,
    userId: `user_${prefix}_${suffix}`,
  };
}

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function byTypeClient() {
  return setupApp({ context })(zeroConnectorsByTypeContract);
}

function manualGrantClient() {
  return setupApp({ context })(zeroConnectorManualGrantContract);
}

function connectorsClient() {
  return setupApp({ context })(zeroConnectorsMainContract);
}

function secretsClient() {
  return setupApp({ context })(zeroSecretsContract);
}

function secretByNameClient() {
  return setupApp({ context })(zeroSecretsByNameContract);
}

function variablesClient() {
  return setupApp({ context })(zeroVariablesContract);
}

function variableByNameClient() {
  return setupApp({ context })(zeroVariablesByNameContract);
}

function mockSession(member: Actor): void {
  mocks.clerk.session(member.userId, member.orgId);
}

const trackConnector = createFixtureTracker<ActorConnector>(
  async (connector) => {
    mockSession(connector.actor);
    await accept(
      byTypeClient().delete({
        params: { type: connector.type },
        headers: authHeaders(),
      }),
      [204, 404],
    );
  },
);

const trackSecret = createFixtureTracker<NamedUserResource>(
  async (resource) => {
    mockSession(resource.actor);
    await accept(
      secretByNameClient().delete({
        params: { name: resource.name },
        headers: authHeaders(),
      }),
      [204, 404],
    );
  },
);

const trackVariable = createFixtureTracker<NamedUserResource>(
  async (resource) => {
    mockSession(resource.actor);
    await accept(
      variableByNameClient().delete({
        params: { name: resource.name },
        headers: authHeaders(),
      }),
      [204, 404],
    );
  },
);

async function connectManualGrant(args: {
  readonly actor: Actor;
  readonly type: ConnectorType;
  readonly values: Record<string, string>;
}): Promise<string> {
  mockSession(args.actor);
  const response = await accept(
    manualGrantClient().connect({
      params: { type: args.type },
      body: {
        authMethod: "api-token",
        values: args.values,
      },
      headers: authHeaders(),
    }),
    [200],
  );

  await trackConnector(Promise.resolve({ actor: args.actor, type: args.type }));
  expect(response.body.type).toBe(args.type);
  return response.body.id;
}

async function createUserSecret(args: {
  readonly actor: Actor;
  readonly name: string;
}): Promise<void> {
  mockSession(args.actor);
  await accept(
    secretsClient().set({
      headers: authHeaders(),
      body: {
        name: args.name,
        value: `secret-${randomUUID()}`,
      },
    }),
    [200, 201],
  );
  await trackSecret(Promise.resolve({ actor: args.actor, name: args.name }));
}

async function createUserVariable(args: {
  readonly actor: Actor;
  readonly name: string;
  readonly value: string;
}): Promise<void> {
  mockSession(args.actor);
  await accept(
    variablesClient().set({
      headers: authHeaders(),
      body: {
        name: args.name,
        value: args.value,
      },
    }),
    [200, 201],
  );
  await trackVariable(Promise.resolve({ actor: args.actor, name: args.name }));
}

function hasSecret(
  secrets: readonly { readonly name: string; readonly type: string }[],
  expected: { readonly name: string; readonly type: string },
): boolean {
  return secrets.some((secret) => {
    return secret.name === expected.name && secret.type === expected.type;
  });
}

function hasConnectorBinding(
  bindings: readonly unknown[],
  expected: { readonly connectorType: string; readonly name: string },
): boolean {
  return bindings.some((binding) => {
    return (
      typeof binding === "object" &&
      binding !== null &&
      "connectorType" in binding &&
      "name" in binding &&
      binding.connectorType === expected.connectorType &&
      binding.name === expected.name
    );
  });
}

describe("/api/zero/connectors/:type delete BDD", () => {
  it("requires authentication, an active organization, and existing connector state", async () => {
    const client = byTypeClient();

    const unauthenticated = await accept(
      client.delete({ params: { type: "github" }, headers: {} }),
      [401],
    );

    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    mocks.clerk.session(`user_${randomUUID()}`, null);
    const noOrganization = await accept(
      client.delete({
        params: { type: "github" },
        headers: authHeaders(),
      }),
      [401],
    );

    expect(noOrganization.body.error.code).toBe("UNAUTHORIZED");

    const member = actor("connector_delete_missing");
    mockSession(member);
    const missing = await accept(
      client.delete({
        params: { type: "github" },
        headers: authHeaders(),
      }),
      [404],
    );

    expect(missing.body).toStrictEqual({
      error: { message: "Connector not found", code: "NOT_FOUND" },
    });
  });

  it("deletes a manual-grant connector and route-visible connector-owned state", async () => {
    const member = actor("connector_delete_manual");
    const connectorId = await connectManualGrant({
      actor: member,
      type: "atlassian",
      values: {
        ATLASSIAN_TOKEN: "atlassian-token",
        ATLASSIAN_EMAIL: "test@example.com",
        ATLASSIAN_DOMAIN: "example",
      },
    });

    mockSession(member);
    const connected = await accept(
      byTypeClient().get({
        params: { type: "atlassian" },
        headers: authHeaders(),
      }),
      [200],
    );
    const visibleBeforeDelete = await accept(
      connectorsClient().list({ headers: authHeaders() }),
      [200],
    );
    const secretsBeforeDelete = await accept(
      secretsClient().list({ headers: authHeaders() }),
      [200],
    );

    expect(connected.body).toMatchObject({
      id: connectorId,
      type: "atlassian",
      authMethod: "api-token",
      connectionStatus: "connected",
    });
    expect(
      hasConnectorBinding(visibleBeforeDelete.body.connectorProvidedBindings, {
        connectorType: "atlassian",
        name: "ATLASSIAN_TOKEN",
      }),
    ).toBeTruthy();
    expect(
      hasConnectorBinding(visibleBeforeDelete.body.connectorProvidedBindings, {
        connectorType: "atlassian",
        name: "ATLASSIAN_EMAIL",
      }),
    ).toBeTruthy();
    expect(
      hasSecret(secretsBeforeDelete.body.secrets, {
        name: "ATLASSIAN_TOKEN",
        type: "connector",
      }),
    ).toBeTruthy();

    const deleted = await accept(
      byTypeClient().delete({
        params: { type: "atlassian" },
        headers: authHeaders(),
      }),
      [204],
    );

    expect(deleted.body).toBeUndefined();

    const afterDelete = await accept(
      byTypeClient().get({
        params: { type: "atlassian" },
        headers: authHeaders(),
      }),
      [404],
    );
    const visibleAfterDelete = await accept(
      connectorsClient().list({ headers: authHeaders() }),
      [200],
    );
    const secretsAfterDelete = await accept(
      secretsClient().list({ headers: authHeaders() }),
      [200],
    );

    expect(afterDelete.body.error.code).toBe("NOT_FOUND");
    expect(
      visibleAfterDelete.body.connectors.some((connector) => {
        return connector.type === "atlassian";
      }),
    ).toBeFalsy();
    expect(
      hasConnectorBinding(visibleAfterDelete.body.connectorProvidedBindings, {
        connectorType: "atlassian",
        name: "ATLASSIAN_TOKEN",
      }),
    ).toBeFalsy();
    expect(
      hasSecret(secretsAfterDelete.body.secrets, {
        name: "ATLASSIAN_TOKEN",
        type: "connector",
      }),
    ).toBeFalsy();
  });

  it("returns 404 and preserves user-owned credential state without a connector row", async () => {
    const member = actor("connector_delete_user_credentials");
    await createUserSecret({ actor: member, name: "ATLASSIAN_TOKEN" });
    await createUserVariable({
      actor: member,
      name: "ATLASSIAN_EMAIL",
      value: "test@example.com",
    });
    await createUserVariable({
      actor: member,
      name: "ATLASSIAN_DOMAIN",
      value: "example",
    });

    mockSession(member);
    const response = await accept(
      byTypeClient().delete({
        params: { type: "atlassian" },
        headers: authHeaders(),
      }),
      [404],
    );
    const secrets = await accept(
      secretsClient().list({ headers: authHeaders() }),
      [200],
    );
    const variables = await accept(
      variablesClient().list({ headers: authHeaders() }),
      [200],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Connector not found", code: "NOT_FOUND" },
    });
    expect(
      hasSecret(secrets.body.secrets, {
        name: "ATLASSIAN_TOKEN",
        type: "user",
      }),
    ).toBeTruthy();
    expect(variables.body.variables).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "ATLASSIAN_DOMAIN",
          value: "example",
        }),
        expect.objectContaining({
          name: "ATLASSIAN_EMAIL",
          value: "test@example.com",
        }),
      ]),
    );
  });

  it("deletes optional manual-grant connectors through the public route", async () => {
    const member = actor("connector_delete_optional");
    await connectManualGrant({
      actor: member,
      type: "gitlab",
      values: {
        GITLAB_TOKEN: "glpat-test",
        GITLAB_HOST: "gitlab.example.com",
      },
    });

    mockSession(member);
    await accept(
      byTypeClient().delete({
        params: { type: "gitlab" },
        headers: authHeaders(),
      }),
      [204],
    );

    const afterDelete = await accept(
      byTypeClient().get({
        params: { type: "gitlab" },
        headers: authHeaders(),
      }),
      [404],
    );
    const secrets = await accept(
      secretsClient().list({ headers: authHeaders() }),
      [200],
    );

    expect(afterDelete.body.error.code).toBe("NOT_FOUND");
    expect(
      hasSecret(secrets.body.secrets, {
        name: "GITLAB_TOKEN",
        type: "connector",
      }),
    ).toBeFalsy();
  });
});
