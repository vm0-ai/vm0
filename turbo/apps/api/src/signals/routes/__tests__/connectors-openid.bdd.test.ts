import { randomUUID } from "node:crypto";

import { connectorsSlugCallbackContract } from "@okouai/api-contracts/contracts/connectors-slug-callback";
import type { ConnectorAccountMutationIntent } from "@okouai/api-contracts/contracts/connector-accounts";
import {
  connectorOpenIdStartContract,
  connectorsBySlugContract,
} from "@okouai/api-contracts/contracts/connectors";
import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { createRouteMocks } from "./helpers/route-test";
import { connectorsSlugCallbackRoutes } from "../connectors-slug-callback";
import { connectorCatalogRoutes } from "../connector-catalog";
import { connectorsRoutes } from "../connectors";

const context = testContext();
const mocks = createRouteMocks(context);

const STEAM_ID = "76561198000000000";

interface TestActor {
  readonly userId: string;
  readonly orgId: string;
}

function testActor(): TestActor {
  return {
    userId: `user_steam_${randomUUID()}`,
    orgId: `org_steam_${randomUUID()}`,
  };
}

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function mockSession(actor: TestActor): void {
  mocks.clerk.session(actor.userId, actor.orgId);
}

function mockSteamRuntimeEnv(): void {
  mockEnv("OKOU_API_BACKEND_URL", "https://api.vm0.ai");
  mockEnv("OKOU_WEB_URL", "https://www.vm0.ai");
}

async function startSteamOpenId(
  actor: TestActor,
  account: ConnectorAccountMutationIntent = { intent: "single-account" },
): Promise<URL> {
  mockSession(actor);
  const response = await accept(
    setupApp({ context, routes: connectorsRoutes })(
      connectorOpenIdStartContract,
    ).start({
      params: { connectorSlug: "steam" },
      headers: authHeaders(),
      body: { authMethod: "openid", account },
    }),
    [200],
  );
  return new URL(response.body.authorizationUrl);
}

function stateFromSteamAuthorizationUrl(authorizationUrl: URL): string {
  const returnTo = authorizationUrl.searchParams.get("openid.return_to");
  if (!returnTo) {
    throw new Error("Steam authorization URL is missing openid.return_to");
  }
  const state = new URL(returnTo).searchParams.get("state");
  if (!state) {
    throw new Error("Steam return_to is missing state");
  }
  return state;
}

function steamCallbackQuery(authorizationUrl: URL) {
  const returnTo = authorizationUrl.searchParams.get("openid.return_to");
  if (!returnTo) {
    throw new Error("Steam authorization URL is missing openid.return_to");
  }
  const claimedId = `https://steamcommunity.com/openid/id/${STEAM_ID}`;
  return {
    state: stateFromSteamAuthorizationUrl(authorizationUrl),
    "openid.ns": "http://specs.openid.net/auth/2.0",
    "openid.mode": "id_res",
    "openid.op_endpoint": "https://steamcommunity.com/openid/login",
    "openid.claimed_id": claimedId,
    "openid.identity": claimedId,
    "openid.return_to": returnTo,
    "openid.response_nonce": "2026-07-06T00:00:00Znonce",
    "openid.assoc_handle": "assoc-handle",
    "openid.signed":
      "op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle",
    "openid.sig": "signature",
  };
}

function mockSteamOpenIdVerification(valid = true): void {
  server.use(
    http.post(
      "https://steamcommunity.com/openid/login",
      async ({ request }) => {
        const body = new URLSearchParams(await request.text());
        expect(body.get("openid.mode")).toBe("check_authentication");
        return new HttpResponse(
          [
            "ns:http://specs.openid.net/auth/2.0",
            `is_valid:${valid ? "true" : "false"}`,
            "",
          ].join("\n"),
          { headers: { "content-type": "text/plain" } },
        );
      },
    ),
  );
}

interface RedirectResponseLike {
  readonly headers: Headers;
}

function redirectLocation(response: RedirectResponseLike): URL {
  const location = response.headers.get("location");
  if (!location) {
    throw new Error("Expected a redirect location header");
  }
  return new URL(location);
}

function expectConnectorErrorRedirect(
  response: RedirectResponseLike,
  args: { readonly connectorSlug: string; readonly message: string },
): void {
  const url = redirectLocation(response);
  expect(url.pathname).toBe("/connector/error");
  expect(url.searchParams.get("connectorSlug")).toBe(args.connectorSlug);
  expect(url.searchParams.get("message")).toBe(args.message);
}

async function completeSteamOpenIdCallback(
  authorizationUrl: URL,
): Promise<void> {
  mockSteamOpenIdVerification();
  await accept(
    setupApp({ context, routes: connectorsSlugCallbackRoutes })(
      connectorsSlugCallbackContract,
    ).callback({
      params: { connectorSlug: "steam" },
      query: steamCallbackQuery(authorizationUrl),
      headers: {},
    }),
    [307],
  );
}

describe("Steam OpenID connector", () => {
  it("exposes Steam in the connector catalog by default", async () => {
    const actor = testActor();
    mockSession(actor);

    const client = setupApp({ context, routes: connectorCatalogRoutes })(
      connectorCatalogContract,
    );
    const visible = await accept(
      client.status({ headers: authHeaders() }),
      [200],
    );
    const steam = visible.body.connectors.find((connector) => {
      return connector.slug === "steam";
    });
    expect(steam).toMatchObject({
      slug: "steam",
      connected: false,
      authMethods: [
        expect.objectContaining({
          id: "openid",
          grantKind: "openid-auth",
        }),
      ],
    });
  });

  it("starts Steam OpenID auth and stores the verified SteamID on callback", async () => {
    const actor = testActor();
    mockSteamRuntimeEnv();

    const authorizationUrl = await startSteamOpenId(actor);
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
      "https://steamcommunity.com/openid/login",
    );
    expect(authorizationUrl.searchParams.get("openid.realm")).toBe(
      "https://api.vm0.ai/",
    );
    expect(authorizationUrl.searchParams.get("openid.return_to")).toMatch(
      /^https:\/\/api\.vm0\.ai\/api\/connectors\/steam\/callback\?state=[0-9a-f]{64}$/u,
    );

    await completeSteamOpenIdCallback(authorizationUrl);

    mockSession(actor);
    const connector = await accept(
      setupApp({ context, routes: connectorsRoutes })(
        connectorsBySlugContract,
      ).get({
        params: { connectorSlug: "steam" },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(connector.body).toMatchObject({
      slug: "steam",
      authMethod: "openid",
      externalId: STEAM_ID,
      externalUsername: STEAM_ID,
      connectionStatus: "connected",
      oauthScopes: [],
    });
  });

  it("keeps the active Steam connection until a verified replacement succeeds", async () => {
    const actor = testActor();
    mockSteamRuntimeEnv();
    const initialAuthorizationUrl = await startSteamOpenId(actor);
    await completeSteamOpenIdCallback(initialAuthorizationUrl);

    mockSession(actor);
    const initial = await accept(
      setupApp({ context, routes: connectorsRoutes })(
        connectorsBySlugContract,
      ).get({
        params: { connectorSlug: "steam" },
        headers: authHeaders(),
      }),
      [200],
    );

    const authorizationUrl = await startSteamOpenId(actor);
    mockSession(actor);
    const whilePending = await accept(
      setupApp({ context, routes: connectorsRoutes })(
        connectorsBySlugContract,
      ).get({
        params: { connectorSlug: "steam" },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(whilePending.body).toStrictEqual(initial.body);

    mockSteamOpenIdVerification(false);

    const response = await accept(
      setupApp({ context, routes: connectorsSlugCallbackRoutes })(
        connectorsSlugCallbackContract,
      ).callback({
        params: { connectorSlug: "steam" },
        query: steamCallbackQuery(authorizationUrl),
        headers: {},
      }),
      [307],
    );

    expectConnectorErrorRedirect(response, {
      connectorSlug: "steam",
      message: "OpenID authorization failed. Please try again.",
    });

    mockSession(actor);
    const connector = await accept(
      setupApp({ context, routes: connectorsRoutes })(
        connectorsBySlugContract,
      ).get({
        params: { connectorSlug: "steam" },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(connector.body).toStrictEqual(initial.body);

    const replacementAuthorizationUrl = await startSteamOpenId(actor, {
      intent: "single-account",
    });
    await completeSteamOpenIdCallback(replacementAuthorizationUrl);
    mockSession(actor);
    const replaced = await accept(
      setupApp({ context, routes: connectorsRoutes })(
        connectorsBySlugContract,
      ).get({
        params: { connectorSlug: "steam" },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(replaced.body.id).toBe(initial.body.id);
    expect(replaced.body.externalId).toBe(STEAM_ID);
  });

  it("rejects OpenID start requests for non-OpenID connector methods", async () => {
    const actor = testActor();
    mockSession(actor);

    const response = await accept(
      setupApp({ context, routes: connectorsRoutes })(
        connectorOpenIdStartContract,
      ).start({
        params: { connectorSlug: "github" },
        headers: authHeaders(),
        body: { authMethod: "oauth", account: { intent: "single-account" } },
      }),
      [400],
    );
    expect(response.body.error.message).toContain("auth grant");
    expect(response.body.error.message).toContain("OpenID");
  });
});
