import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";
import {
  zeroConnectorManualGrantContract,
  zeroConnectorsByTypeContract,
  zeroConnectorsMainContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import {
  zeroSecretsByNameContract,
  zeroSecretsContract,
} from "@vm0/api-contracts/contracts/zero-secrets";
import type { ConnectorType } from "@vm0/connectors/connectors";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
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

interface ActorSecret {
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

function bearerHeaders(token: string): { readonly authorization: string } {
  return { authorization: `Bearer ${token}` };
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

function mockSession(member: Actor): void {
  mocks.clerk.session(member.userId, member.orgId);
}

function mockClerkMembership(member: Actor): void {
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [{ organization: { id: member.orgId }, role: "org:admin" }],
  });
}

function zeroToken(args: {
  readonly actor: Actor;
  readonly capabilities: readonly ZeroCapability[];
}): string {
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "zero",
    userId: args.actor.userId,
    orgId: args.actor.orgId,
    runId: `run_${randomUUID()}`,
    capabilities: [...args.capabilities],
    iat: seconds,
    exp: seconds + 600,
  });
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

const trackSecret = createFixtureTracker<ActorSecret>(async (secret) => {
  mockSession(secret.actor);
  await accept(
    secretByNameClient().delete({
      params: { name: secret.name },
      headers: authHeaders(),
    }),
    [204, 404],
  );
});

async function connectOpenAi(member: Actor): Promise<string> {
  mockSession(member);
  const response = await accept(
    manualGrantClient().connect({
      params: { type: "openai" },
      body: {
        authMethod: "api-token",
        values: { OPENAI_TOKEN: `sk-${randomUUID()}` },
      },
      headers: authHeaders(),
    }),
    [200],
  );

  await trackConnector(Promise.resolve({ actor: member, type: "openai" }));
  expect(response.body.type).toBe("openai");
  expect(response.body.authMethod).toBe("api-token");
  return response.body.id;
}

async function connectZendesk(member: Actor): Promise<string> {
  mockSession(member);
  const response = await accept(
    manualGrantClient().connect({
      params: { type: "zendesk" },
      body: {
        authMethod: "api-token",
        values: {
          ZENDESK_API_TOKEN: `zendesk-${randomUUID()}`,
          ZENDESK_EMAIL: "support@example.com",
          ZENDESK_SUBDOMAIN: "example",
        },
      },
      headers: authHeaders(),
    }),
    [200],
  );

  await trackConnector(Promise.resolve({ actor: member, type: "zendesk" }));
  expect(response.body.type).toBe("zendesk");
  expect(response.body.authMethod).toBe("api-token");
  return response.body.id;
}

async function createUserSecret(member: Actor, name: string): Promise<void> {
  mockSession(member);
  await accept(
    secretsClient().set({
      headers: authHeaders(),
      body: {
        name,
        value: `secret-${randomUUID()}`,
      },
    }),
    [200, 201],
  );
  await trackSecret(Promise.resolve({ actor: member, name }));
}

describe("/api/zero/connectors/:type BDD", () => {
  it("requires authentication, an active organization, and connector:read for zero tokens", async () => {
    const client = byTypeClient();

    const unauthenticated = await accept(
      client.get({ params: { type: "openai" }, headers: {} }),
      [401],
    );

    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    mocks.clerk.session(`user_${randomUUID()}`, null);
    const noOrganization = await accept(
      client.get({
        params: { type: "openai" },
        headers: authHeaders(),
      }),
      [401],
    );

    expect(noOrganization.body.error.code).toBe("UNAUTHORIZED");

    const member = actor("connector_by_type_auth");
    const missingCapability = await accept(
      client.get({
        params: { type: "openai" },
        headers: bearerHeaders(
          zeroToken({ actor: member, capabilities: ["agent:read"] }),
        ),
      }),
      [403],
    );

    expect(missingCapability.body.error.code).toBe("FORBIDDEN");
  });

  it("returns 404 for missing connectors and user-owned credential secrets", async () => {
    const member = actor("connector_by_type_missing");
    mockSession(member);
    const client = byTypeClient();

    const missing = await accept(
      client.get({
        params: { type: "openai" },
        headers: authHeaders(),
      }),
      [404],
    );

    expect(missing.body).toStrictEqual({
      error: { message: "Connector not found", code: "NOT_FOUND" },
    });

    await createUserSecret(member, "OPENAI_TOKEN");
    mockSession(member);

    const legacyUserSecret = await accept(
      client.get({
        params: { type: "openai" },
        headers: authHeaders(),
      }),
      [404],
    );

    expect(legacyUserSecret.body).toStrictEqual({
      error: { message: "Connector not found", code: "NOT_FOUND" },
    });
  });

  it("reads and deletes a connector created through manual grant", async () => {
    const member = actor("connector_by_type_read");
    const connectorId = await connectOpenAi(member);
    const client = byTypeClient();

    mockSession(member);
    const connected = await accept(
      client.get({
        params: { type: "openai" },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(connected.body).toMatchObject({
      id: connectorId,
      type: "openai",
      authMethod: "api-token",
      connectionStatus: "connected",
    });

    const deleted = await accept(
      client.delete({
        params: { type: "openai" },
        headers: authHeaders(),
      }),
      [204],
    );

    expect(deleted.body).toBeUndefined();

    const afterDelete = await accept(
      client.get({
        params: { type: "openai" },
        headers: authHeaders(),
      }),
      [404],
    );

    expect(afterDelete.body.error.code).toBe("NOT_FOUND");
  });

  it("exposes connector-provided bindings for a connector created through manual grant", async () => {
    const member = actor("connector_by_type_bindings");
    const connectorId = await connectZendesk(member);

    mockSession(member);
    const byType = await accept(
      byTypeClient().get({
        params: { type: "zendesk" },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(byType.body).toMatchObject({
      id: connectorId,
      type: "zendesk",
      authMethod: "api-token",
      connectionStatus: "connected",
    });

    mockSession(member);
    const list = await accept(
      connectorsClient().list({ headers: authHeaders() }),
      [200],
    );

    expect(
      list.body.connectors.some((connector) => {
        return connector.id === connectorId && connector.type === "zendesk";
      }),
    ).toBeTruthy();
    expect(list.body.connectorProvidedBindings).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          connectorType: "zendesk",
          authMethod: "api-token",
          namespace: "secrets",
          name: "ZENDESK_API_TOKEN",
          source: { kind: "connector-secret", name: "ZENDESK_API_TOKEN" },
        }),
        expect.objectContaining({
          connectorType: "zendesk",
          authMethod: "api-token",
          namespace: "vars",
          name: "ZENDESK_EMAIL",
          source: { kind: "connector-variable", name: "ZENDESK_EMAIL" },
        }),
        expect.objectContaining({
          connectorType: "zendesk",
          authMethod: "api-token",
          namespace: "vars",
          name: "ZENDESK_SUBDOMAIN",
          source: { kind: "connector-variable", name: "ZENDESK_SUBDOMAIN" },
        }),
      ]),
    );
  });

  it("allows zero-token reads when Clerk confirms organization membership", async () => {
    const member = actor("connector_by_type_zero");
    await connectOpenAi(member);
    mockClerkMembership(member);
    const token = zeroToken({
      actor: member,
      capabilities: ["connector:read"],
    });

    const response = await accept(
      byTypeClient().get({
        params: { type: "openai" },
        headers: bearerHeaders(token),
      }),
      [200],
    );

    expect(response.body.type).toBe("openai");
  });
});
