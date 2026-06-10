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

function connectorsClient() {
  return setupApp({ context })(zeroConnectorsMainContract);
}

function byTypeClient() {
  return setupApp({ context })(zeroConnectorsByTypeContract);
}

function manualGrantClient() {
  return setupApp({ context })(zeroConnectorManualGrantContract);
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
      body: { name, value: `secret-${randomUUID()}` },
    }),
    [200, 201],
  );
  await trackSecret(Promise.resolve({ actor: member, name }));
}

describe("/api/zero/connectors list BDD", () => {
  it("requires authentication, an active organization, and connector:read for zero tokens", async () => {
    const client = connectorsClient();

    const unauthenticated = await accept(client.list({ headers: {} }), [401]);

    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    mocks.clerk.session(`user_${randomUUID()}`, null);
    const noOrganization = await accept(
      client.list({ headers: authHeaders() }),
      [401],
    );

    expect(noOrganization.body.error.code).toBe("UNAUTHORIZED");

    const member = actor("connectors_list_auth");
    const missingCapability = await accept(
      client.list({
        headers: bearerHeaders(
          zeroToken({ actor: member, capabilities: ["agent:read"] }),
        ),
      }),
      [403],
    );

    expect(missingCapability.body.error.code).toBe("FORBIDDEN");
  });

  it("returns empty list metadata without inferring legacy user-owned credential secrets", async () => {
    const member = actor("connectors_list_empty");
    mockSession(member);
    const client = connectorsClient();

    const empty = await accept(client.list({ headers: authHeaders() }), [200]);

    expect(empty.body.connectors).toStrictEqual([]);
    expect(Array.isArray(empty.body.configuredTypes)).toBeTruthy();
    expect(Array.isArray(empty.body.connectorProvidedBindings)).toBeTruthy();

    await createUserSecret(member, "OPENAI_TOKEN");
    mockSession(member);

    const afterUserSecret = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );

    expect(
      afterUserSecret.body.connectors.find((connector) => {
        return connector.type === "openai";
      }),
    ).toBeUndefined();
  });

  it("lists API-created connectors, connector-provided bindings, and per-user isolation", async () => {
    const owner = actor("connectors_list_owner");
    const sameOrgOtherUser = {
      orgId: owner.orgId,
      userId: `user_${randomUUID()}`,
    };
    const otherOrg = actor("connectors_list_other_org");
    const openaiId = await connectOpenAi(owner);
    const zendeskId = await connectZendesk(owner);
    await connectOpenAi(sameOrgOtherUser);
    await connectOpenAi(otherOrg);
    const client = connectorsClient();

    mockSession(owner);
    const ownerList = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );

    expect(ownerList.body.connectors).toHaveLength(2);
    expect(
      ownerList.body.connectors.map((connector) => {
        return connector.type;
      }),
    ).toStrictEqual(["openai", "zendesk"]);
    expect(
      ownerList.body.connectors.find((connector) => {
        return connector.id === openaiId;
      }),
    ).toMatchObject({
      type: "openai",
      authMethod: "api-token",
      connectionStatus: "connected",
    });
    expect(
      ownerList.body.connectors.find((connector) => {
        return connector.id === zendeskId;
      }),
    ).toMatchObject({
      type: "zendesk",
      authMethod: "api-token",
      connectionStatus: "connected",
    });
    expect(ownerList.body.connectorProvidedBindings).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          connectorType: "openai",
          authMethod: "api-token",
          namespace: "secrets",
          name: "OPENAI_TOKEN",
          source: { kind: "connector-secret", name: "OPENAI_TOKEN" },
        }),
        expect.objectContaining({
          connectorType: "zendesk",
          authMethod: "api-token",
          namespace: "vars",
          name: "ZENDESK_EMAIL",
          source: { kind: "connector-variable", name: "ZENDESK_EMAIL" },
        }),
      ]),
    );

    mockSession(sameOrgOtherUser);
    const sameOrgOtherUserList = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );

    expect(sameOrgOtherUserList.body.connectors).toHaveLength(1);
    expect(sameOrgOtherUserList.body.connectors[0]?.type).toBe("openai");

    mockSession(otherOrg);
    const otherOrgList = await accept(
      client.list({ headers: authHeaders() }),
      [200],
    );

    expect(otherOrgList.body.connectors).toHaveLength(1);
    expect(otherOrgList.body.connectors[0]?.type).toBe("openai");
  });

  it("allows zero-token reads when Clerk confirms organization membership", async () => {
    const member = actor("connectors_list_zero");
    await connectOpenAi(member);
    mockClerkMembership(member);

    const response = await accept(
      connectorsClient().list({
        headers: bearerHeaders(
          zeroToken({ actor: member, capabilities: ["connector:read"] }),
        ),
      }),
      [200],
    );

    expect(response.body.connectors).toHaveLength(1);
    expect(response.body.connectors[0]?.type).toBe("openai");
  });
});
