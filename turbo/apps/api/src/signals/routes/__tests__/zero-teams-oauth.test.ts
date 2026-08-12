import { createStore } from "ccstate";
import { zeroTeamsConnectContract } from "@vm0/api-contracts/contracts/zero-teams-connect";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { createAppWithRoutes } from "../../../app-factory-core";
import { mockEnv } from "../../../lib/env";
import { server } from "../../../mocks/server";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { zeroTeamsOauthRoutes } from "../zero-teams-oauth";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import { seedOrgMembership$ } from "./helpers/zero-org-membership";
import {
  installTeamsForTest,
  removeTeamsForTest,
  setupTeamsConnectTestEnv,
  teamsConnectFixture,
  type TeamsConnectFixture,
} from "./helpers/zero-teams-connect";
import { zeroTeamsConnectRoutes } from "../zero-teams-connect";

const context = testContext();
const mocks = createZeroRouteMocks(context);
const store = createStore();
const API_ORIGIN = "https://api.vm0.ai";
const WEB_ORIGIN = "https://www.vm0.ai";
const APP_ORIGIN = "https://app.vm0.test";
const MICROSOFT_TOKEN_URL =
  "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const MICROSOFT_ME_URL = "https://graph.microsoft.com/v1.0/me";
const TEAMS_APP_ID = "00000000-0000-0000-0000-000000000001";
const TEAMS_APP_TENANT_ID = "11111111-1111-1111-1111-111111111111";

async function appRequest(
  path: string,
  options: {
    readonly origin?: string;
    readonly headers?: RequestInit["headers"];
  } = {},
): Promise<Response> {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: zeroTeamsOauthRoutes,
  });
  return await app.request(`${options.origin ?? "http://api.test"}${path}`, {
    method: "GET",
    headers: options.headers,
  });
}

function encodeJwtPart(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function idToken(payload: Readonly<Record<string, unknown>>): string {
  return `${encodeJwtPart({ alg: "none" })}.${encodeJwtPart(payload)}.sig`;
}

function callbackPath(args: {
  readonly code?: string;
  readonly namespace?: "okou" | "zero";
  readonly state: Readonly<Record<string, unknown>>;
}): string {
  const params = new URLSearchParams();
  if (args.code) {
    params.set("code", args.code);
  }
  params.set("state", JSON.stringify(args.state));
  return `/api/${args.namespace ?? "zero"}/teams/oauth/callback?${params.toString()}`;
}

function teamsInstallUrl(tenantId: string): string {
  const url = new URL(`https://teams.microsoft.com/l/app/${TEAMS_APP_ID}`);
  url.searchParams.set("installAppPackage", "true");
  url.searchParams.set("appTenantId", TEAMS_APP_TENANT_ID);
  url.searchParams.set("tenantId", tenantId);
  return url.toString();
}

function mockMicrosoftOAuth(args: {
  readonly tenantId: string;
  readonly aadObjectId: string;
  readonly displayName?: string;
  readonly userPrincipalName: string;
  readonly expectedRedirectUri?: string;
}): void {
  server.use(
    http.post(MICROSOFT_TOKEN_URL, async ({ request }) => {
      const body = new URLSearchParams(await request.text());
      expect(body.get("client_id")).toBe("test-microsoft-client-id");
      expect(body.get("client_secret")).toBe("test-microsoft-client-secret");
      expect(body.get("redirect_uri")).toBe(
        args.expectedRedirectUri ??
          `${API_ORIGIN}/api/zero/teams/oauth/callback`,
      );
      expect(body.get("grant_type")).toBe("authorization_code");
      return HttpResponse.json({
        access_token: "ms-access-token",
        id_token: idToken({
          tid: args.tenantId,
          oid: args.aadObjectId,
        }),
      });
    }),
    http.get(MICROSOFT_ME_URL, ({ request }) => {
      expect(request.headers.get("authorization")).toBe(
        "Bearer ms-access-token",
      );
      return HttpResponse.json({
        id: args.aadObjectId,
        displayName: args.displayName ?? "Ada Lovelace",
        userPrincipalName: args.userPrincipalName,
        mail: null,
      });
    }),
  );
}

async function seedMembership(
  orgId: string,
  userId: string,
  role: "admin" | "member" = "admin",
): Promise<void> {
  await store.set(seedOrgMembership$, { orgId, userId, role }, context.signal);
}

async function uninstalledTeamsFixture(
  track: (
    fixturePromise: Promise<TeamsConnectFixture>,
  ) => Promise<TeamsConnectFixture>,
): Promise<TeamsConnectFixture> {
  return await track(Promise.resolve(teamsConnectFixture()));
}

async function seedTeamsInstallation(
  track: (
    fixturePromise: Promise<TeamsConnectFixture>,
  ) => Promise<TeamsConnectFixture>,
): Promise<TeamsConnectFixture> {
  const fixture = await track(Promise.resolve(teamsConnectFixture()));
  await installTeamsForTest(context.signal, fixture);
  return fixture;
}

describe("Teams OAuth API routes", () => {
  const track = createFixtureTracker<TeamsConnectFixture>((fixture) => {
    return removeTeamsForTest(context.signal, fixture);
  });

  beforeEach(() => {
    setupTeamsConnectTestEnv(APP_ORIGIN, API_ORIGIN);
    mockEnv("VM0_WEB_URL", WEB_ORIGIN);
    mockEnv("MICROSOFT_OAUTH_CLIENT_ID", "test-microsoft-client-id");
    mockEnv("MICROSOFT_OAUTH_CLIENT_SECRET", "test-microsoft-client-secret");
  });

  it("redirects to Microsoft OAuth with connect state without a browser session", async () => {
    const response = await appRequest(
      "/api/zero/teams/oauth/connect?orgId=org_1&vm0UserId=user_1",
    );

    expect(response.status).toBe(307);
    const redirectUrl = new URL(response.headers.get("location")!);
    expect(redirectUrl.origin + redirectUrl.pathname).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    );
    expect(redirectUrl.searchParams.get("client_id")).toBe(
      "test-microsoft-client-id",
    );
    expect(redirectUrl.searchParams.get("redirect_uri")).toBe(
      `${API_ORIGIN}/api/zero/teams/oauth/callback`,
    );
    expect(redirectUrl.searchParams.get("scope")).toBe(
      "openid profile email User.Read",
    );
    const state = JSON.parse(redirectUrl.searchParams.get("state")!) as {
      readonly orgId: string;
      readonly vm0UserId: string;
    };
    expect(state).toStrictEqual({ orgId: "org_1", vm0UserId: "user_1" });
  });

  it("uses the canonical callback for canonical connect requests", async () => {
    const response = await appRequest(
      "/api/okou/teams/oauth/connect?orgId=org_1&vm0UserId=user_1",
    );

    expect(response.status).toBe(307);
    const redirectUrl = new URL(response.headers.get("location")!);
    expect(redirectUrl.searchParams.get("redirect_uri")).toBe(
      `${API_ORIGIN}/api/okou/teams/oauth/callback`,
    );
  });

  it("keeps API-host connect requests on the API callback origin", async () => {
    const response = await appRequest(
      "/api/zero/teams/oauth/connect?orgId=org_1&vm0UserId=user_1",
      { origin: API_ORIGIN },
    );

    expect(response.status).toBe(307);
    const redirectUrl = new URL(response.headers.get("location")!);
    expect(redirectUrl.origin + redirectUrl.pathname).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    );
    expect(redirectUrl.searchParams.get("redirect_uri")).toBe(
      `${API_ORIGIN}/api/zero/teams/oauth/callback`,
    );
  });

  it("rejects connect requests without org and user state", async () => {
    const response = await appRequest("/api/zero/teams/oauth/connect");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Missing orgId or vm0UserId",
    });
  });

  it("prepares a Teams install after OAuth and binds it when Teams sends installation metadata", async () => {
    const fixture = await uninstalledTeamsFixture(track);
    await seedMembership(fixture.orgId, fixture.userId, "admin");
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    mockMicrosoftOAuth({
      tenantId: fixture.teamsTenantId,
      aadObjectId: fixture.teamsAadObjectId,
      userPrincipalName: fixture.teamsUserPrincipalName,
    });

    const response = await appRequest(
      callbackPath({
        code: "valid-code",
        state: { orgId: fixture.orgId, vm0UserId: fixture.userId },
      }),
      { origin: API_ORIGIN },
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      teamsInstallUrl(fixture.teamsTenantId),
    );

    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const client = setupApp({ context, routes: zeroTeamsConnectRoutes })(
      zeroTeamsConnectContract,
    );
    const pendingStatus = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(pendingStatus.body).toMatchObject({
      isInstalled: false,
      isConnected: false,
      installUrl: teamsInstallUrl(fixture.teamsTenantId),
    });

    await installTeamsForTest(context.signal, fixture);
    const installedStatus = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(installedStatus.body).toMatchObject({
      isInstalled: true,
      isConnected: true,
      installUrl: null,
      connectUrl: null,
      tenantId: fixture.teamsTenantId,
    });
  });

  it("uses the canonical callback for canonical token exchanges", async () => {
    const fixture = await uninstalledTeamsFixture(track);
    await seedMembership(fixture.orgId, fixture.userId, "admin");
    mockMicrosoftOAuth({
      tenantId: fixture.teamsTenantId,
      aadObjectId: fixture.teamsAadObjectId,
      userPrincipalName: fixture.teamsUserPrincipalName,
      expectedRedirectUri: `${API_ORIGIN}/api/okou/teams/oauth/callback`,
    });

    const response = await appRequest(
      callbackPath({
        code: "valid-code",
        namespace: "okou",
        state: { orgId: fixture.orgId, vm0UserId: fixture.userId },
      }),
      { origin: API_ORIGIN },
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      teamsInstallUrl(fixture.teamsTenantId),
    );
  });

  it("connects and binds an unbound Teams installation using Microsoft OAuth", async () => {
    const fixture = await seedTeamsInstallation(track);
    await seedMembership(fixture.orgId, fixture.userId, "admin");
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    mockMicrosoftOAuth({
      tenantId: fixture.teamsTenantId,
      aadObjectId: fixture.teamsAadObjectId,
      userPrincipalName: fixture.teamsUserPrincipalName,
    });

    const response = await appRequest(
      callbackPath({
        code: "valid-code",
        state: { orgId: fixture.orgId, vm0UserId: fixture.userId },
      }),
      { origin: API_ORIGIN },
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain(
      `${APP_ORIGIN}/settings/teams?status=connected`,
    );

    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const client = setupApp({ context, routes: zeroTeamsConnectRoutes })(
      zeroTeamsConnectContract,
    );
    const status = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(status.body).toMatchObject({
      isInstalled: true,
      isConnected: true,
      connectUrl: null,
      tenantId: fixture.teamsTenantId,
    });
  });

  it("rejects OAuth users when the org is already bound to another Microsoft tenant", async () => {
    const fixture = await seedTeamsInstallation(track);
    await seedMembership(fixture.orgId, fixture.userId, "admin");
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const client = setupApp({ context, routes: zeroTeamsConnectRoutes })(
      zeroTeamsConnectContract,
    );
    await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          tenantId: fixture.teamsTenantId,
          teamsUserId: fixture.teamsUserId,
          teamsAadObjectId: fixture.teamsAadObjectId,
        },
      }),
      [200],
    );

    mockMicrosoftOAuth({
      tenantId: `other-${fixture.teamsTenantId}`,
      aadObjectId: fixture.teamsAadObjectId,
      userPrincipalName: fixture.teamsUserPrincipalName,
    });

    const response = await appRequest(
      callbackPath({
        code: "valid-code",
        state: { orgId: fixture.orgId, vm0UserId: fixture.userId },
      }),
      { origin: API_ORIGIN },
    );

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toContain(`${APP_ORIGIN}/settings/teams?error=`);
    expect(new URL(location!).searchParams.get("error")).toContain(
      "active organization doesn't match",
    );
  });

  it("rejects callback state when the vm0 user is not an org member", async () => {
    const fixture = await seedTeamsInstallation(track);
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: [],
    });

    const response = await appRequest(
      callbackPath({
        code: "valid-code",
        state: { orgId: fixture.orgId, vm0UserId: fixture.userId },
      }),
      { origin: API_ORIGIN },
    );

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toContain(`${APP_ORIGIN}/settings/teams?error=`);
    expect(new URL(location!).searchParams.get("error")).toBe(
      "Invalid connect state.",
    );
  });
});
