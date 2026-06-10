import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  zeroConnectorManualGrantContract,
  zeroConnectorsByTypeContract,
  zeroConnectorsMainContract,
} from "@vm0/api-contracts/contracts/zero-connectors";
import { zeroFeatureSwitchesContract } from "@vm0/api-contracts/contracts/zero-feature-switches";
import { zeroSecretsContract } from "@vm0/api-contracts/contracts/zero-secrets";
import type { ConnectorType } from "@vm0/connectors/connectors";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { createApp } from "../../../app-factory";
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

function manualGrantClient() {
  return setupApp({ context })(zeroConnectorManualGrantContract);
}

function byTypeClient() {
  return setupApp({ context })(zeroConnectorsByTypeContract);
}

function connectorsClient() {
  return setupApp({ context })(zeroConnectorsMainContract);
}

function secretsClient() {
  return setupApp({ context })(zeroSecretsContract);
}

function featureSwitchesClient() {
  return setupApp({ context })(zeroFeatureSwitchesContract);
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

const trackFeatureSwitchActor = createFixtureTracker<Actor>(async (member) => {
  mockSession(member);
  await accept(
    featureSwitchesClient().delete({
      headers: authHeaders(),
    }),
    [200],
  );
});

async function connectManualGrant(args: {
  readonly actor: Actor;
  readonly type: ConnectorType;
  readonly values: Record<string, string>;
}) {
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
  expect(response.body.authMethod).toBe("api-token");
  return response.body;
}

async function enableFeatureSwitches(
  member: Actor,
  switches: Record<string, boolean>,
): Promise<void> {
  mockSession(member);
  await accept(
    featureSwitchesClient().update({
      headers: authHeaders(),
      body: { switches },
    }),
    [200],
  );
  await trackFeatureSwitchActor(Promise.resolve(member));
}

function expectBinding(
  bindings: readonly unknown[],
  expected: {
    readonly connectorType: string;
    readonly namespace: string;
    readonly name: string;
  },
): void {
  expect(bindings).toStrictEqual(
    expect.arrayContaining([expect.objectContaining(expected)]),
  );
}

function expectNoSecretNamed(
  secrets: readonly { readonly name: string }[],
  name: string,
): void {
  expect(
    secrets.find((secret) => {
      return secret.name === name;
    }),
  ).toBeUndefined();
}

describe("/api/zero/connectors/:type/manual-grant BDD", () => {
  it("requires authentication, an active organization, and a selected auth method", async () => {
    const client = manualGrantClient();

    const unauthenticated = await accept(
      client.connect({
        params: { type: "openai" },
        body: {
          authMethod: "api-token",
          values: { OPENAI_TOKEN: "sk-test" },
        },
        headers: {},
      }),
      [401],
    );

    expect(unauthenticated.body.error.code).toBe("UNAUTHORIZED");

    mocks.clerk.session(`user_${randomUUID()}`, null);
    const noOrganization = await accept(
      client.connect({
        params: { type: "openai" },
        body: {
          authMethod: "api-token",
          values: { OPENAI_TOKEN: "sk-test" },
        },
        headers: authHeaders(),
      }),
      [401],
    );

    expect(noOrganization.body.error.code).toBe("UNAUTHORIZED");

    const member = actor("manual_grant_shape");
    mockSession(member);
    const app = createApp({ signal: context.signal });
    const missingAuthMethod = await app.request(
      "/api/zero/connectors/openai/manual-grant",
      {
        method: "POST",
        headers: {
          authorization: authHeaders().authorization,
          "content-type": "application/json",
        },
        body: JSON.stringify({ values: { OPENAI_TOKEN: "sk-test" } }),
      },
    );

    expect(missingAuthMethod.status).toBe(400);
  });

  it("connects manual-grant connectors and exposes their route-visible bindings", async () => {
    const member = actor("manual_grant_connect");
    context.mocks.ably.publish.mockClear();

    const openai = await connectManualGrant({
      actor: member,
      type: "openai",
      values: { OPENAI_TOKEN: " sk-test\n" },
    });

    expect(typeof openai.id).toBe("string");
    expect(openai.createdAt).not.toBe("1970-01-01T00:00:00.000Z");
    expect(openai.updatedAt).not.toBe("1970-01-01T00:00:00.000Z");
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "connector:changed",
      null,
    );

    mockSession(member);
    const openaiRead = await accept(
      byTypeClient().get({
        params: { type: "openai" },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(openaiRead.body).toMatchObject({
      id: openai.id,
      type: "openai",
      authMethod: "api-token",
      connectionStatus: "connected",
    });

    await connectManualGrant({
      actor: member,
      type: "zendesk",
      values: {
        ZENDESK_API_TOKEN: " zendesk\n-token ",
        ZENDESK_EMAIL: " support@example.com ",
        ZENDESK_SUBDOMAIN: " example ",
      },
    });
    await connectManualGrant({
      actor: member,
      type: "lark",
      values: {
        LARK_APP_ID: " cli_a123 ",
        LARK_APP_SECRET: " lark-app-secret\n",
      },
    });

    mockSession(member);
    const list = await accept(
      connectorsClient().list({ headers: authHeaders() }),
      [200],
    );

    expect(
      list.body.connectors.map((connector) => {
        return connector.type;
      }),
    ).toStrictEqual(expect.arrayContaining(["lark", "openai", "zendesk"]));
    expectBinding(list.body.connectorProvidedBindings, {
      connectorType: "openai",
      namespace: "secrets",
      name: "OPENAI_TOKEN",
    });
    expectBinding(list.body.connectorProvidedBindings, {
      connectorType: "zendesk",
      namespace: "secrets",
      name: "ZENDESK_API_TOKEN",
    });
    expectBinding(list.body.connectorProvidedBindings, {
      connectorType: "zendesk",
      namespace: "vars",
      name: "ZENDESK_EMAIL",
    });
    expectBinding(list.body.connectorProvidedBindings, {
      connectorType: "zendesk",
      namespace: "vars",
      name: "ZENDESK_SUBDOMAIN",
    });

    mockSession(member);
    const secretList = await accept(
      secretsClient().list({ headers: authHeaders() }),
      [200],
    );

    expect(secretList.body.secrets).toStrictEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "OPENAI_TOKEN",
          type: "connector",
        }),
        expect.objectContaining({
          name: "ZENDESK_API_TOKEN",
          type: "connector",
        }),
        expect.objectContaining({
          name: "LARK_APP_SECRET",
          type: "connector",
        }),
      ]),
    );
    expectNoSecretNamed(secretList.body.secrets, "LARK_ACCESS_TOKEN");
    expectNoSecretNamed(secretList.body.secrets, "LARK_TOKEN");
  });

  it("reconnects API-token connectors and keeps connector access route-visible", async () => {
    const member = actor("manual_grant_reconnect");
    const firstGitlab = await connectManualGrant({
      actor: member,
      type: "gitlab",
      values: {
        GITLAB_TOKEN: "glpat-first",
        GITLAB_HOST: "gitlab.example.com",
      },
    });

    mockSession(member);
    const firstRead = await accept(
      byTypeClient().get({
        params: { type: "gitlab" },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(firstRead.body).toMatchObject({
      id: firstGitlab.id,
      type: "gitlab",
      authMethod: "api-token",
      connectionStatus: "connected",
    });

    const secondGitlab = await connectManualGrant({
      actor: member,
      type: "gitlab",
      values: { GITLAB_TOKEN: "glpat-second" },
    });

    expect(secondGitlab.id).toBe(firstGitlab.id);

    mockSession(member);
    const afterReconnect = await accept(
      byTypeClient().get({
        params: { type: "gitlab" },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(afterReconnect.body).toMatchObject({
      id: firstGitlab.id,
      type: "gitlab",
      authMethod: "api-token",
      connectionStatus: "connected",
    });
  });

  it("validates fields, connector availability, and feature-gated manual grants", async () => {
    const member = actor("manual_grant_validation");
    mockSession(member);
    const client = manualGrantClient();

    const unknownField = await accept(
      client.connect({
        params: { type: "openai" },
        body: {
          authMethod: "api-token",
          values: {
            OPENAI_TOKEN: "sk-test",
            EXTRA_TOKEN: "secret-value-should-not-echo",
          },
        },
        headers: authHeaders(),
      }),
      [400],
    );

    expect(unknownField.body.error.message).toContain("EXTRA_TOKEN");
    expect(unknownField.body.error.message).not.toContain(
      "secret-value-should-not-echo",
    );

    const missingRequired = await accept(
      client.connect({
        params: { type: "openai" },
        body: { authMethod: "api-token", values: {} },
        headers: authHeaders(),
      }),
      [400],
    );

    expect(missingRequired.body.error.message).toContain("OPENAI_TOKEN");

    const emptyRequired = await accept(
      client.connect({
        params: { type: "openai" },
        body: {
          authMethod: "api-token",
          values: { OPENAI_TOKEN: " \n\t " },
        },
        headers: authHeaders(),
      }),
      [400],
    );

    expect(emptyRequired.body.error.message).toContain("OPENAI_TOKEN");

    const unsupportedAuthMethod = await accept(
      client.connect({
        params: { type: "github" },
        body: { authMethod: "api-token", values: {} },
        headers: authHeaders(),
      }),
      [400],
    );

    expect(unsupportedAuthMethod.body.error.message).toContain(
      "github connector does not have api-token auth method",
    );

    const nonManualGrant = await accept(
      client.connect({
        params: { type: "stripe" },
        body: {
          authMethod: "oauth",
          values: { STRIPE_TOKEN: "sk_test_key" },
        },
        headers: authHeaders(),
      }),
      [400],
    );

    expect(nonManualGrant.body.error.message).toContain(
      "stripe oauth auth method does not use a manual grant",
    );

    const unavailableFeature = await accept(
      client.connect({
        params: { type: "bentoml" },
        body: {
          authMethod: "api-token",
          values: {
            BENTO_CLOUD_API_KEY: "bento-token",
            BENTO_CLOUD_API_ENDPOINT: "https://example.bentoml.test",
          },
        },
        headers: authHeaders(),
      }),
      [403],
    );

    expect(unavailableFeature.body.error.code).toBe("FORBIDDEN");

    await enableFeatureSwitches(member, {
      [FeatureSwitchKey.BentomlConnector]: true,
    });

    const availableFeature = await connectManualGrant({
      actor: member,
      type: "bentoml",
      values: {
        BENTO_CLOUD_API_KEY: "bento-token",
        BENTO_CLOUD_API_ENDPOINT: "https://example.bentoml.test",
      },
    });

    expect(availableFeature).toMatchObject({
      type: "bentoml",
      authMethod: "api-token",
      connectionStatus: "connected",
    });
  });
});
