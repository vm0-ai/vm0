import { describe, expect, it, beforeEach } from "vitest";
import { zeroTeamsConnectContract } from "@vm0/api-contracts/contracts/zero-teams-connect";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
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
const TEAMS_APP_TENANT_ID = "11111111-1111-1111-1111-111111111111";

function teamsInstallUrl(tenantId?: string): string {
  const url = new URL(
    "https://teams.microsoft.com/l/app/00000000-0000-0000-0000-000000000001",
  );
  url.searchParams.set("installAppPackage", "true");
  url.searchParams.set("appTenantId", TEAMS_APP_TENANT_ID);
  if (tenantId) {
    url.searchParams.set("tenantId", tenantId);
  }
  return url.toString();
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
  values: Partial<TeamsConnectFixture> = {},
): Promise<TeamsConnectFixture> {
  const fixture = await track(Promise.resolve(teamsConnectFixture(values)));
  await installTeamsForTest(context.signal, fixture);
  return fixture;
}

describe("GET /api/zero/integrations/teams/connect", () => {
  const track = createFixtureTracker<TeamsConnectFixture>((fixture) => {
    return removeTeamsForTest(context.signal, fixture);
  });

  beforeEach(() => {
    setupTeamsConnectTestEnv();
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(zeroTeamsConnectContract);

    const response = await accept(client.getStatus({ headers: {} }), [401]);

    expect(response.body).toStrictEqual({
      error: {
        message: "Not authenticated",
        code: "UNAUTHORIZED",
      },
    });
  });

  it("returns uninstalled status when the org has no Teams installation", async () => {
    mocks.clerk.session("user_empty", "org_empty", "org:admin");

    const client = setupApp({ context })(zeroTeamsConnectContract);

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      isInstalled: false,
      isConnected: false,
      isAdmin: true,
      installUrl: teamsInstallUrl(),
    });
  });

  it("returns installed but disconnected status for an unlinked user", async () => {
    const fixture = await seedTeamsInstallation(track);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(zeroTeamsConnectContract);
    await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: connectBody(fixture),
      }),
      [200],
    );
    await accept(
      client.disconnect({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      isInstalled: true,
      isConnected: false,
      isAdmin: true,
      installUrl: teamsInstallUrl(fixture.teamsTenantId),
      tenantId: fixture.teamsTenantId,
      tenantName: fixture.teamsTenantName,
      teamId: fixture.teamsTeamId,
      teamName: fixture.teamsTeamName,
      defaultAgentName: null,
    });
  });

  it("returns connected status when the user has a Teams connection", async () => {
    const fixture = await seedTeamsInstallation(track);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const client = setupApp({ context })(zeroTeamsConnectContract);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: connectBody(fixture),
      }),
      [200],
    );
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      isInstalled: true,
      isConnected: true,
      isAdmin: false,
      installUrl: teamsInstallUrl(fixture.teamsTenantId),
      tenantId: fixture.teamsTenantId,
      tenantName: fixture.teamsTenantName,
      teamId: fixture.teamsTeamId,
      teamName: fixture.teamsTeamName,
      defaultAgentName: null,
    });
  });
});

describe("POST /api/zero/integrations/teams/connect", () => {
  const track = createFixtureTracker<TeamsConnectFixture>((fixture) => {
    return removeTeamsForTest(context.signal, fixture);
  });

  beforeEach(() => {
    setupTeamsConnectTestEnv();
  });

  it("binds an unbound Teams installation for an admin and creates one connection", async () => {
    const fixture = await seedTeamsInstallation(track);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(zeroTeamsConnectContract);
    const response = await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: connectBody(fixture),
      }),
      [200],
    );

    expect(response.body).toMatchObject({
      success: true,
      role: "admin",
    });

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
  });

  it("rejects a member connecting an unbound Teams installation", async () => {
    const fixture = await seedTeamsInstallation(track);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:member");

    const client = setupApp({ context })(zeroTeamsConnectContract);
    const response = await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: connectBody(fixture),
      }),
      [403],
    );

    expect(response.body.error.message).toContain("org admins");
  });

  it("allows a member to connect to a bound Teams installation", async () => {
    const fixture = await seedTeamsInstallation(track);
    const adminUserId = `admin_${fixture.userId}`;
    const memberUserId = `member_${fixture.userId}`;

    const client = setupApp({ context })(zeroTeamsConnectContract);
    mocks.clerk.session(adminUserId, fixture.orgId, "org:admin");
    await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: connectBody(fixture, "29:admin-user"),
      }),
      [200],
    );

    mocks.clerk.session(memberUserId, fixture.orgId, "org:member");
    const response = await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: connectBody(fixture, "29:member-user"),
      }),
      [200],
    );

    expect(response.body.role).toBe("member");
    const status = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(status.body.isConnected).toBeTruthy();
  });

  it("rejects users from the wrong org with a clear error", async () => {
    const fixture = await seedTeamsInstallation(track);
    const client = setupApp({ context })(zeroTeamsConnectContract);

    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");
    await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: connectBody(fixture),
      }),
      [200],
    );

    mocks.clerk.session(fixture.userId, "org_other", "org:admin");
    const response = await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: connectBody(fixture),
      }),
      [403],
    );

    expect(response.body.error.message).toContain("active organization");
  });

  it("keeps repeated connects for the same Teams user idempotent", async () => {
    const fixture = await seedTeamsInstallation(track);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(zeroTeamsConnectContract);
    const first = await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: connectBody(fixture),
      }),
      [200],
    );
    const second = await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: connectBody(fixture),
      }),
      [200],
    );

    expect(second.body.connectionId).toBe(first.body.connectionId);
  });
});

describe("DELETE /api/zero/integrations/teams/connect", () => {
  const track = createFixtureTracker<TeamsConnectFixture>((fixture) => {
    return removeTeamsForTest(context.signal, fixture);
  });

  beforeEach(() => {
    setupTeamsConnectTestEnv();
  });

  it("disconnects the current user without uninstalling Teams", async () => {
    const fixture = await seedTeamsInstallation(track);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(zeroTeamsConnectContract);
    await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: connectBody(fixture),
      }),
      [200],
    );
    const response = await accept(
      client.disconnect({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ success: true });

    const status = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(status.body).toMatchObject({
      isInstalled: true,
      isConnected: false,
      tenantId: fixture.teamsTenantId,
    });
  });

  it("lets admins uninstall Teams for the org", async () => {
    const fixture = await seedTeamsInstallation(track);
    mocks.clerk.session(fixture.userId, fixture.orgId, "org:admin");

    const client = setupApp({ context })(zeroTeamsConnectContract);
    await accept(
      client.connect({
        headers: { authorization: "Bearer clerk-session" },
        body: connectBody(fixture),
      }),
      [200],
    );
    const response = await accept(
      client.disconnect({
        headers: { authorization: "Bearer clerk-session" },
        query: { action: "uninstall" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ success: true });

    const status = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(status.body).toStrictEqual({
      isInstalled: false,
      isConnected: false,
      isAdmin: true,
      installUrl: teamsInstallUrl(),
    });
  });
});
