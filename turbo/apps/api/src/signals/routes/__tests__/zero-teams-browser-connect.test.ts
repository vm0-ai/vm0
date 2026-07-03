import { zeroTeamsConnectContract } from "@vm0/api-contracts/contracts/zero-teams-connect";
import { beforeEach, describe, expect, it } from "vitest";

import { createAppWithRoutes } from "../../../app-factory-core";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { zeroTeamsBrowserConnectRoutes } from "../zero-teams-browser-connect";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  installTeamsForTest,
  removeTeamsForTest,
  setupTeamsConnectTestEnv,
  teamsConnectFixture,
  type TeamsConnectFixture,
} from "./helpers/zero-teams-connect";

const context = testContext();
const mocks = createZeroRouteMocks(context);
const CONNECT_PATH = "http://api.test/api/zero/teams/connect";
const APP_ORIGIN = "https://app.vm0.test";

function connectUrl(params: {
  readonly tenantId?: string;
  readonly teamsUserId?: string;
  readonly displayName?: string;
  readonly upn?: string;
  readonly orgId?: string;
}): string {
  const url = new URL(CONNECT_PATH);
  if (params.tenantId) {
    url.searchParams.set("tenantId", params.tenantId);
  }
  if (params.teamsUserId) {
    url.searchParams.set("teamsUserId", params.teamsUserId);
  }
  if (params.displayName) {
    url.searchParams.set("displayName", params.displayName);
  }
  if (params.upn) {
    url.searchParams.set("upn", params.upn);
  }
  if (params.orgId) {
    url.searchParams.set("orgId", params.orgId);
  }
  return url.toString();
}

async function requestConnect(
  url: string,
  headers?: HeadersInit,
): Promise<Response> {
  const app = createAppWithRoutes({
    signal: context.signal,
    routes: zeroTeamsBrowserConnectRoutes,
  });
  const requestHeaders = headers ?? { cookie: "__session=opaque" };
  return await app.request(url, { method: "GET", headers: requestHeaders });
}

function connectBody(
  fixture: TeamsConnectFixture,
  teamsUserId = fixture.teamsUserId,
) {
  return {
    tenantId: fixture.teamsTenantId,
    teamsUserId,
    teamsUserDisplayName: "Ada Lovelace",
    teamsUserPrincipalName: "ada@example.com",
    teamId: fixture.teamsTeamId,
    teamName: fixture.teamsTeamName,
    serviceUrl: fixture.serviceUrl,
  };
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

async function bindTeamsInstallation(
  fixture: TeamsConnectFixture,
  userId: string,
): Promise<void> {
  mocks.clerk.session(userId, fixture.orgId, "org:admin");
  const client = setupApp({ context })(zeroTeamsConnectContract);
  await accept(
    client.connect({
      headers: { authorization: "Bearer clerk-session" },
      body: connectBody(fixture, "29:admin-user"),
    }),
    [200],
  );
}

async function expectTeamsConnected(
  fixture: TeamsConnectFixture,
): Promise<void> {
  const client = setupApp({ context })(zeroTeamsConnectContract);
  const status = await accept(
    client.getStatus({
      headers: { authorization: "Bearer clerk-session" },
    }),
    [200],
  );
  expect(status.body).toMatchObject({
    isInstalled: true,
    isConnected: true,
    tenantId: fixture.teamsTenantId,
  });
}

describe("GET /api/zero/teams/connect", () => {
  const track = createFixtureTracker<TeamsConnectFixture>((fixture) => {
    return removeTeamsForTest(context.signal, fixture);
  });

  beforeEach(() => {
    setupTeamsConnectTestEnv(APP_ORIGIN);
  });

  it("redirects unauthenticated users to sign-in with redirect_url", async () => {
    const response = await requestConnect(CONNECT_PATH, {});

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();
    const url = new URL(location!);
    expect(url.pathname).toBe("/sign-in");
    expect(url.searchParams.get("redirect_url")).toBe(CONNECT_PATH);
  });

  it("redirects invalid connect links to the Teams connect error page", async () => {
    mocks.clerk.session("user_invalid", "org_invalid", "org:admin");

    const response = await requestConnect(CONNECT_PATH);

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toContain(`${APP_ORIGIN}/settings/teams?error=`);
    expect(new URL(location!).searchParams.get("error")).toContain(
      "Invalid connect link.",
    );
  });

  it("binds an unbound installation for an admin and creates one connection", async () => {
    const fixture = await seedTeamsInstallation(track);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const response = await requestConnect(
      connectUrl({
        tenantId: fixture.teamsTenantId,
        teamsUserId: fixture.teamsUserId,
        displayName: "Ada Lovelace",
        upn: "ada@example.com",
      }),
    );

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toContain(`${APP_ORIGIN}/settings/teams?status=connected`);
    const redirectUrl = new URL(location!);
    expect(redirectUrl.searchParams.get("tenantId")).toBe(
      fixture.teamsTenantId,
    );
    expect(redirectUrl.searchParams.get("teamsUserId")).toBe(
      fixture.teamsUserId,
    );
    expect(redirectUrl.searchParams.get("displayName")).toBe("Ada Lovelace");
    expect(redirectUrl.searchParams.get("upn")).toBe("ada@example.com");
    expect(redirectUrl.searchParams.get("teamName")).toBe(
      fixture.teamsTeamName,
    );
    await expectTeamsConnected(fixture);
  });

  it("rejects a member connecting an unbound installation", async () => {
    const fixture = await seedTeamsInstallation(track);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const response = await requestConnect(
      connectUrl({
        tenantId: fixture.teamsTenantId,
        teamsUserId: fixture.teamsUserId,
      }),
    );

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toContain(`${APP_ORIGIN}/settings/teams?error=`);
    expect(decodeURIComponent(location ?? "")).toContain("admin");
  });

  it("keeps reconnecting the same Teams user idempotent", async () => {
    const fixture = await seedTeamsInstallation(track);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    const url = connectUrl({
      tenantId: fixture.teamsTenantId,
      teamsUserId: fixture.teamsUserId,
    });

    const first = await requestConnect(url);
    const second = await requestConnect(url);

    expect(first.status).toBe(307);
    expect(first.headers.get("location")).toContain(
      `${APP_ORIGIN}/settings/teams?status=connected`,
    );
    expect(second.status).toBe(307);
    expect(second.headers.get("location")).toContain(
      `${APP_ORIGIN}/settings/teams?status=connected`,
    );
    await expectTeamsConnected(fixture);
  });

  it("allows a member to connect to a bound installation", async () => {
    const fixture = await seedTeamsInstallation(track);
    const memberUserId = `member_${fixture.userId}`;
    await bindTeamsInstallation(fixture, `admin_${fixture.userId}`);
    mocks.clerk.session(memberUserId, fixture.orgId, "org:member");

    const response = await requestConnect(
      connectUrl({
        tenantId: fixture.teamsTenantId,
        teamsUserId: "29:member-user",
        orgId: fixture.orgId,
      }),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain(
      `${APP_ORIGIN}/settings/teams?status=connected`,
    );
    await expectTeamsConnected(fixture);
  });

  it("redirects org mismatch to the organization error", async () => {
    const fixture = await seedTeamsInstallation(track);
    await bindTeamsInstallation(fixture, fixture.userId);
    mocks.clerk.session(fixture.userId, "org_other", "org:admin");

    const response = await requestConnect(
      connectUrl({
        tenantId: fixture.teamsTenantId,
        teamsUserId: fixture.teamsUserId,
        orgId: "org_other",
      }),
    );

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toContain(`${APP_ORIGIN}/settings/teams?error=`);
    expect(new URL(location!).searchParams.get("error")).toContain(
      "active organization",
    );
  });
});
