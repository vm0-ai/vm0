import { beforeEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockOptionalEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { installApiTestConnectorCatalog } from "../../../test-fixtures/connector-catalog";
import { connectorCatalogRoutes } from "../connector-catalog";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createConnectorBddApi } from "./helpers/api-bdd-connectors";
import { createRouteMocks } from "./helpers/route-test";
import {
  readConnectorCredentialStorageState,
  readConnectorOAuthAccountMutation,
} from "./helpers/connector-credential-storage-state";

const context = testContext();
const bdd = createBddApi(context);
const connectors = createConnectorBddApi(context);
const SLUG = "optimizely-cmp";
const TOKEN_URL = "https://accounts.cmp.optimizely.com/o/oauth2/v1/token";
const USERINFO_URL = "https://accounts.cmp.optimizely.com/o/oauth2/v1/userinfo";
const REVOKE_URL = "https://accounts.welcomesoftware.com/o/oauth2/v1/revoke";

async function start(
  actor: ApiTestUser,
  clientId: string,
  clientSecret: string,
) {
  const response = await connectors.requestOauthStart(
    actor,
    SLUG,
    "oauth-client",
    {
      statuses: [200],
      oauthClient: { clientId, clientSecret },
    },
  );
  if (response.status !== 200) {
    throw new Error("Expected OAuth start");
  }
  const url = new URL(response.body.authorizationUrl);
  expect(url.searchParams.get("client_id")).toBe(clientId);
  expect(url.searchParams.get("response_type")).toBe("code");
  expect(url.toString()).not.toContain(clientSecret);
  const state = url.searchParams.get("state");
  if (!state) {
    throw new Error("Expected authorization state");
  }
  return state;
}

beforeEach(() => {
  mockOptionalEnv("OPTIMIZELY_CMP_OAUTH_CLIENT_ID", "global-client");
  mockOptionalEnv("OPTIMIZELY_CMP_OAUTH_CLIENT_SECRET", "global-secret");
});

describe("connection-owned user OAuth", () => {
  it("keeps interleaved attempts isolated through encrypted storage, callback replay and deletion", async () => {
    const alice = bdd.user();
    const bob = bdd.user();
    const requests: unknown[] = [];
    const revocations: unknown[] = [];
    server.use(
      http.post(TOKEN_URL, async ({ request }) => {
        const body = await request.json();
        requests.push(body);
        const isAlice = JSON.stringify(body).includes("alice-code");
        return HttpResponse.json({
          access_token: isAlice ? "alice-access" : "bob-access",
          refresh_token: isAlice ? "alice-refresh" : "bob-refresh",
          expires_in: 3600,
        });
      }),
      http.get(USERINFO_URL, ({ request }) => {
        return HttpResponse.json({
          sub: request.headers.get("authorization"),
          name: "CMP user",
        });
      }),
      http.post(REVOKE_URL, async ({ request }) => {
        revocations.push(await request.json());
        return new HttpResponse(null, { status: 200 });
      }),
    );
    const aliceState = await start(alice, "alice-client", "alice-secret");
    const bobState = await start(bob, "bob-client", "bob-secret");
    const pending = await readConnectorOAuthAccountMutation(
      context,
      aliceState,
    );
    expect(pending.encrypted_auth_client).toBeTypeOf("string");
    expect(pending.encrypted_auth_client).not.toContain("alice-client");
    expect(pending.encrypted_auth_client).not.toContain("alice-secret");
    await connectors.completeOauthCallback(SLUG, {
      state: bobState,
      code: "bob-code",
    });
    await connectors.completeOauthCallback(SLUG, {
      state: aliceState,
      code: "alice-code",
    });
    await connectors.completeOauthCallback(SLUG, {
      state: aliceState,
      code: "replayed-code",
    });
    expect(requests).toStrictEqual([
      expect.objectContaining({
        grant_type: "authorization_code",
        code: "bob-code",
        client_id: "bob-client",
        client_secret: "bob-secret",
      }),
      expect.objectContaining({
        grant_type: "authorization_code",
        code: "alice-code",
        client_id: "alice-client",
        client_secret: "alice-secret",
      }),
    ]);
    const aliceConnection = await connectors.readConnectorBySlug(alice, SLUG);
    expect(aliceConnection.authMethod).toBe("oauth-client");
    expect(JSON.stringify(aliceConnection)).not.toContain("alice-secret");
    if (!alice.orgId) {
      throw new Error("Expected organization");
    }
    const stored = await readConnectorCredentialStorageState(context, {
      userId: alice.userId,
      orgId: alice.orgId,
      connectorSlug: SLUG,
      secretNames: ["OPTIMIZELY_CMP_CLIENT_ID", "OPTIMIZELY_CMP_CLIENT_SECRET"],
    });
    expect(stored.secrets).toHaveLength(2);
    for (const secret of stored.secrets ?? []) {
      expect(secret.connector_id).toBe(aliceConnection.id);
      expect(secret.encrypted_value).not.toContain("alice-client");
      expect(secret.encrypted_value).not.toContain("alice-secret");
    }
    await connectors.deleteBuiltinConnectorAccount(
      alice,
      SLUG,
      aliceConnection.id,
    );
    expect(revocations).toStrictEqual([
      expect.objectContaining({
        client_id: "alice-client",
        client_secret: "alice-secret",
        token: "alice-refresh",
      }),
    ]);
    expect(
      (await connectors.readConnectorBySlug(bob, SLUG)).connectionStatus,
    ).toBe("connected");
  });

  it("requires a client for the new method and rejects overriding a platform OAuth client", async () => {
    const actor = bdd.user();
    await expect(
      connectors.requestOauthStart(actor, SLUG, "oauth-client", {
        statuses: [400],
      }),
    ).resolves.toMatchObject({ status: 400 });
    await expect(
      connectors.requestOauthStart(actor, "github", "oauth", {
        statuses: [400],
        oauthClient: { clientId: "override", clientSecret: "override-secret" },
      }),
    ).resolves.toMatchObject({ status: 400 });
  });

  it("exposes the client form requirement without the direct OAuth shortcut or credentials", async () => {
    mockOptionalEnv("OPTIMIZELY_CMP_OAUTH_CLIENT_ID", undefined);
    mockOptionalEnv("OPTIMIZELY_CMP_OAUTH_CLIENT_SECRET", undefined);
    await installApiTestConnectorCatalog();
    const actor = bdd.user();
    createRouteMocks(context).clerk.session(actor.userId, actor.orgId);
    const client = setupApp({ context, routes: connectorCatalogRoutes })(
      connectorCatalogContract,
    );
    const response = await accept(
      client.get({
        params: { connectorSlug: SLUG },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(response.body.connector.authMethods).toStrictEqual([
      expect.objectContaining({
        id: "oauth-client",
        requiresOAuthClient: true,
      }),
    ]);
    expect(response.body.connector.singleAuthCodeAuthMethodId).toBeNull();
    expect(JSON.stringify(response.body)).not.toContain("global-secret");
  });

  it("keeps the legacy OAuth request and state usable with platform credentials", async () => {
    const actor = bdd.user();
    server.use(
      http.post(TOKEN_URL, async ({ request }) => {
        await expect(request.json()).resolves.toMatchObject({
          client_id: "global-client",
          client_secret: "global-secret",
          grant_type: "authorization_code",
        });
        return HttpResponse.json({
          access_token: "legacy-access",
          refresh_token: "legacy-refresh",
          expires_in: 3600,
        });
      }),
      http.get(USERINFO_URL, () => {
        return HttpResponse.json({ sub: "legacy-user" });
      }),
      http.post(REVOKE_URL, async ({ request }) => {
        await expect(request.json()).resolves.toMatchObject({
          client_id: "global-client",
          client_secret: "global-secret",
          token: "legacy-refresh",
        });
        return new HttpResponse(null, { status: 200 });
      }),
    );
    const result = await connectors.startOauth(actor, SLUG, "oauth");
    const state = new URL(result.authorizationUrl).searchParams.get("state");
    if (!state) {
      throw new Error("Expected legacy OAuth state");
    }
    expect(
      (await readConnectorOAuthAccountMutation(context, state))
        .encrypted_auth_client,
    ).toBeNull();
    await connectors.completeOauthCallback(SLUG, {
      state,
      code: "legacy-code",
    });
    const connection = await connectors.readConnectorBySlug(actor, SLUG);
    expect(connection.authMethod).toBe("oauth");
    await connectors.deleteBuiltinConnectorAccount(actor, SLUG, connection.id);
  });

  it("reconnects an exact account with new client credentials and revokes the replacement with those credentials", async () => {
    const actor = bdd.user();
    server.use(
      http.post(TOKEN_URL, () => {
        return HttpResponse.json({
          access_token: "cmp-access",
          refresh_token: "cmp-refresh",
          expires_in: 3600,
        });
      }),
      http.get(USERINFO_URL, () => {
        return HttpResponse.json({ sub: "same-cmp-user" });
      }),
    );
    const state = await start(actor, "original-client", "original-secret");
    await connectors.completeOauthCallback(SLUG, {
      state,
      code: "initial-code",
    });
    const connection = await connectors.readConnectorBySlug(actor, SLUG);
    const response = await connectors.requestOauthStart(
      actor,
      SLUG,
      "oauth-client",
      {
        statuses: [200],
        account: { intent: "reconnect", connectionId: connection.id },
        oauthClient: {
          clientId: "replacement-client",
          clientSecret: "replacement-secret",
        },
      },
    );
    if (response.status !== 200) {
      throw new Error("Expected reconnect start");
    }
    const replacementState = new URL(
      response.body.authorizationUrl,
    ).searchParams.get("state");
    if (!replacementState) {
      throw new Error("Expected reconnect state");
    }
    server.use(
      http.post(TOKEN_URL, async ({ request }) => {
        await expect(request.json()).resolves.toMatchObject({
          client_id: "replacement-client",
          client_secret: "replacement-secret",
        });
        return HttpResponse.json({
          access_token: "replacement-access",
          refresh_token: "replacement-refresh",
          expires_in: 3600,
        });
      }),
      http.post(REVOKE_URL, async ({ request }) => {
        await expect(request.json()).resolves.toMatchObject({
          client_id: "replacement-client",
          client_secret: "replacement-secret",
          token: "replacement-refresh",
        });
        return new HttpResponse(null, { status: 200 });
      }),
    );
    await connectors.completeOauthCallback(SLUG, {
      state: replacementState,
      code: "replacement-code",
    });
    expect((await connectors.readConnectorBySlug(actor, SLUG)).id).toBe(
      connection.id,
    );
    await connectors.deleteBuiltinConnectorAccount(actor, SLUG, connection.id);
  });
});
