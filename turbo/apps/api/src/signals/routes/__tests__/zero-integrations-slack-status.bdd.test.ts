import { randomUUID } from "node:crypto";

import { zeroIntegrationsSlackContract } from "@vm0/api-contracts/contracts/zero-integrations-slack";
import { createStore } from "ccstate";
import { beforeEach, describe, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockEnv } from "../../../lib/env";
import {
  deleteSlackIntegrationFixture$,
  seedSlackEnvironmentAgent$,
  seedSlackOrgConnection$,
  seedSlackOrgInstallation$,
  type SlackIntegrationFixture,
} from "./helpers/zero-integrations-slack";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

// BDD migration of the legacy
// `zero-integrations-slack-status.test.ts`. The 14
// legacy `it()`s collapse into 3 BDD `it()`s:
// (1) auth + install + connect chain (401
// unauthenticated → 401 no org → 200 isConnected=
// false with connect URL → 200 install URL on the
// web origin when Slack is not installed → 200
// workspace info for connected user → 200 empty
// environment details when no default agent version),
// (2) admin + environment chain (200 isAdmin=true for
// admin → 200 isAdmin=false for non-admin → 200
// environment info when connected),
// (3) scope mismatch chain (200 scopeMismatch=false
// when all scopes present → 200 scopeMismatch=true
// when missing scopes → 200 null bot_scopes treated
// as mismatch → 200 scopeMismatch not exposed to
// non-admin → 200 scopeMismatch for admin when user
// is not connected).

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

const FULL_SCOPES = [
  "app_mentions:read",
  "chat:write",
  "channels:read",
  "channels:history",
  "groups:read",
  "groups:history",
  "im:history",
  "im:write",
  "commands",
  "users:read",
  "users:read.email",
  "reactions:write",
  "files:read",
  "files:write",
] as const;

describe("BDD GET /api/zero/integrations/slack — auth + install + connect chain", () => {
  const track = createFixtureTracker<SlackIntegrationFixture>((fixture) => {
    return store.set(deleteSlackIntegrationFixture$, fixture, context.signal);
  });

  beforeEach(() => {
    mockEnv("SLACK_OAUTH_CLIENT_ID", "test-slack-client-id");
    mockEnv("VM0_WEB_URL", "https://www.vm0.ai");
  });

  it("gwt-wt-wt: 401 unauthenticated → 401 no org → 200 isConnected=false with connect URL → 200 install URL on the web origin when Slack is not installed → 200 workspace info for connected user → 200 empty environment details when no default agent version", async () => {
    // Given: no auth header.

    // When + Then: 401.
    const noAuth = await accept(apiClient().getStatus({ headers: {} }), [401]);
    expect(noAuth.body.error.code).toBe("UNAUTHORIZED");

    // Given: a Clerk session with no org.

    // When + Then: 401.
    mocks.clerk.session(`user_${randomUUID()}`, null);
    const noOrg = await accept(
      apiClient().getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );
    expect(noOrg.body.error.code).toBe("UNAUTHORIZED");

    // Given: a seeded Slack org installation + a Clerk
    // session with no user connection.

    // When + Then: 200 — isConnected=false + the
    // connectUrl points at the web origin and carries
    // orgId + vm0UserId.
    const disconnectedOrgId = `org_${randomUUID()}`;
    const disconnectedUserId = `user_${randomUUID()}`;
    await track(
      store.set(
        seedSlackOrgInstallation$,
        { orgId: disconnectedOrgId },
        context.signal,
      ),
    );
    mocks.clerk.session(disconnectedUserId, disconnectedOrgId);
    const disconnectedResponse = await accept(
      apiClient().getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(disconnectedResponse.body.isConnected).toBeFalsy();
    expect(disconnectedResponse.body.connectUrl).not.toBeNull();
    const connectUrl = new URL(disconnectedResponse.body.connectUrl!);
    expect(`${connectUrl.origin}${connectUrl.pathname}`).toBe(
      "https://www.vm0.ai/api/zero/slack/oauth/connect",
    );
    expect(connectUrl.searchParams.get("orgId")).toBe(disconnectedOrgId);
    expect(connectUrl.searchParams.get("vm0UserId")).toBe(disconnectedUserId);

    // Given: a Clerk admin session with no Slack
    // installation.

    // When + Then: 200 — installUrl points at the
    // web origin and carries orgId + vm0UserId.
    const installOrgId = `org_${randomUUID()}`;
    const installUserId = `user_${randomUUID()}`;
    mocks.clerk.session(installUserId, installOrgId, "org:admin");
    const installResponse = await accept(
      apiClient().getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(installResponse.body.installUrl).not.toBeNull();
    const installUrl = new URL(installResponse.body.installUrl!);
    expect(`${installUrl.origin}${installUrl.pathname}`).toBe(
      "https://www.vm0.ai/api/zero/slack/oauth/install",
    );
    expect(installUrl.searchParams.get("orgId")).toBe(installOrgId);
    expect(installUrl.searchParams.get("vm0UserId")).toBe(installUserId);

    // Given: a seeded Slack org installation + a
    // user-level Slack connection for the current
    // user.

    // When + Then: 200 — isConnected=true + the
    // workspace name is exposed.
    const connectedOrgId = `org_${randomUUID()}`;
    const connectedUserId = `user_${randomUUID()}`;
    const connectedFixture = await track(
      store.set(
        seedSlackOrgInstallation$,
        { orgId: connectedOrgId },
        context.signal,
      ),
    );
    await store.set(
      seedSlackOrgConnection$,
      {
        slackWorkspaceId: connectedFixture.slackWorkspaceId,
        vm0UserId: connectedUserId,
      },
      context.signal,
    );
    mocks.clerk.session(connectedUserId, connectedOrgId);
    const connectedResponse = await accept(
      apiClient().getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(connectedResponse.body.isConnected).toBeTruthy();
    expect(connectedResponse.body.workspaceName).toBe("Test Org Workspace");

    // Given: the same connected user but with no
    // default agent version.

    // When + Then: 200 — environment is the empty
    // shape (no required/missing secrets or vars).
    const envOrgId = `org_${randomUUID()}`;
    const envUserId = `user_${randomUUID()}`;
    const envFixture = await track(
      store.set(seedSlackOrgInstallation$, { orgId: envOrgId }, context.signal),
    );
    await store.set(
      seedSlackOrgConnection$,
      {
        slackWorkspaceId: envFixture.slackWorkspaceId,
        vm0UserId: envUserId,
      },
      context.signal,
    );
    mocks.clerk.session(envUserId, envOrgId);
    const envResponse = await accept(
      apiClient().getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(envResponse.body.environment).toStrictEqual({
      requiredSecrets: [],
      requiredVars: [],
      missingSecrets: [],
      missingVars: [],
    });
  });
});

describe("BDD GET /api/zero/integrations/slack — admin + environment chain", () => {
  const track = createFixtureTracker<SlackIntegrationFixture>((fixture) => {
    return store.set(deleteSlackIntegrationFixture$, fixture, context.signal);
  });

  beforeEach(() => {
    mockEnv("SLACK_OAUTH_CLIENT_ID", "test-slack-client-id");
    mockEnv("VM0_WEB_URL", "https://www.vm0.ai");
  });

  it("gwt-wt-wt: 200 isAdmin=true for admin → 200 isAdmin=false for non-admin → 200 environment info when connected", async () => {
    // Given: a connected user session as `org:admin`.

    // When + Then: 200 — isAdmin=true.
    const adminOrgId = `org_${randomUUID()}`;
    const adminUserId = `user_${randomUUID()}`;
    const adminFixture = await track(
      store.set(
        seedSlackOrgInstallation$,
        { orgId: adminOrgId },
        context.signal,
      ),
    );
    await store.set(
      seedSlackOrgConnection$,
      {
        slackWorkspaceId: adminFixture.slackWorkspaceId,
        vm0UserId: adminUserId,
      },
      context.signal,
    );
    mocks.clerk.session(adminUserId, adminOrgId, "org:admin");
    const adminResponse = await accept(
      apiClient().getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(adminResponse.body.isAdmin).toBeTruthy();

    // Given: a connected user session as `org:member`.

    // When + Then: 200 — isAdmin=false.
    const memberOrgId = `org_${randomUUID()}`;
    const memberUserId = `user_${randomUUID()}`;
    const memberFixture = await track(
      store.set(
        seedSlackOrgInstallation$,
        { orgId: memberOrgId },
        context.signal,
      ),
    );
    await store.set(
      seedSlackOrgConnection$,
      {
        slackWorkspaceId: memberFixture.slackWorkspaceId,
        vm0UserId: memberUserId,
      },
      context.signal,
    );
    mocks.clerk.session(memberUserId, memberOrgId, "org:member");
    const memberResponse = await accept(
      apiClient().getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(memberResponse.body.isAdmin).toBeFalsy();

    // Given: a connected user session + a seeded
    // environment agent.

    // When + Then: 200 — environment shape exposes
    // the expected required/missing fields.
    const envOrgId = `org_${randomUUID()}`;
    const envUserId = `user_${randomUUID()}`;
    const envFixture = await track(
      store.set(seedSlackOrgInstallation$, { orgId: envOrgId }, context.signal),
    );
    await store.set(
      seedSlackOrgConnection$,
      {
        slackWorkspaceId: envFixture.slackWorkspaceId,
        vm0UserId: envUserId,
      },
      context.signal,
    );
    await store.set(
      seedSlackEnvironmentAgent$,
      { orgId: envOrgId, userId: envUserId },
      context.signal,
    );
    mocks.clerk.session(envUserId, envOrgId);
    const envResponse = await accept(
      apiClient().getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(envResponse.body.environment).toBeDefined();
    expect(envResponse.body.environment?.requiredSecrets).toBeDefined();
    expect(envResponse.body.environment?.requiredVars).toBeDefined();
    expect(envResponse.body.environment?.missingSecrets).toBeDefined();
    expect(envResponse.body.environment?.missingVars).toBeDefined();
  });
});

describe("BDD GET /api/zero/integrations/slack — scope mismatch chain", () => {
  const track = createFixtureTracker<SlackIntegrationFixture>((fixture) => {
    return store.set(deleteSlackIntegrationFixture$, fixture, context.signal);
  });

  beforeEach(() => {
    mockEnv("SLACK_OAUTH_CLIENT_ID", "test-slack-client-id");
    mockEnv("VM0_WEB_URL", "https://www.vm0.ai");
  });

  it("gwt-wt-wt: 200 scopeMismatch=false when all scopes present → 200 scopeMismatch=true when missing scopes → 200 null bot_scopes treated as mismatch → 200 scopeMismatch not exposed to non-admin → 200 scopeMismatch for admin when user is not connected", async () => {
    // Given: a connected admin session + an
    // installation with the full scope list.

    // When + Then: 200 — scopeMismatch=false +
    // reinstallUrl is null.
    const fullOrgId = `org_${randomUUID()}`;
    const fullUserId = `user_${randomUUID()}`;
    const fullFixture = await track(
      store.set(
        seedSlackOrgInstallation$,
        {
          orgId: fullOrgId,
          botScopes: JSON.stringify([...FULL_SCOPES]),
        },
        context.signal,
      ),
    );
    await store.set(
      seedSlackOrgConnection$,
      {
        slackWorkspaceId: fullFixture.slackWorkspaceId,
        vm0UserId: fullUserId,
      },
      context.signal,
    );
    mocks.clerk.session(fullUserId, fullOrgId, "org:admin");
    const fullResponse = await accept(
      apiClient().getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(fullResponse.body.scopeMismatch).toBeFalsy();
    expect(fullResponse.body.reinstallUrl).toBeNull();

    // Given: a connected admin session + an
    // installation with only a partial scope list.

    // When + Then: 200 — scopeMismatch=true +
    // reinstallUrl points at the install endpoint and
    // includes reinstall=1.
    const missingOrgId = `org_${randomUUID()}`;
    const missingUserId = `user_${randomUUID()}`;
    const missingFixture = await track(
      store.set(
        seedSlackOrgInstallation$,
        {
          orgId: missingOrgId,
          botScopes: JSON.stringify(["chat:write", "channels:read"]),
        },
        context.signal,
      ),
    );
    await store.set(
      seedSlackOrgConnection$,
      {
        slackWorkspaceId: missingFixture.slackWorkspaceId,
        vm0UserId: missingUserId,
      },
      context.signal,
    );
    mocks.clerk.session(missingUserId, missingOrgId, "org:admin");
    const missingResponse = await accept(
      apiClient().getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(missingResponse.body.scopeMismatch).toBeTruthy();
    expect(missingResponse.body.reinstallUrl).toContain(
      "/api/zero/slack/oauth/install",
    );
    expect(missingResponse.body.reinstallUrl).toContain("reinstall=1");

    // Given: a connected admin session + an
    // installation with botScopes=null.

    // When + Then: 200 — scopeMismatch=true.
    const nullScopesOrgId = `org_${randomUUID()}`;
    const nullScopesUserId = `user_${randomUUID()}`;
    const nullScopesFixture = await track(
      store.set(
        seedSlackOrgInstallation$,
        {
          orgId: nullScopesOrgId,
          botScopes: null,
        },
        context.signal,
      ),
    );
    await store.set(
      seedSlackOrgConnection$,
      {
        slackWorkspaceId: nullScopesFixture.slackWorkspaceId,
        vm0UserId: nullScopesUserId,
      },
      context.signal,
    );
    mocks.clerk.session(nullScopesUserId, nullScopesOrgId, "org:admin");
    const nullScopesResponse = await accept(
      apiClient().getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(nullScopesResponse.body.scopeMismatch).toBeTruthy();

    // Given: a connected member session + an
    // installation with a partial scope list.

    // When + Then: 200 — scopeMismatch and
    // reinstallUrl are undefined for non-admin.
    const memberOrgId = `org_${randomUUID()}`;
    const memberUserId = `user_${randomUUID()}`;
    const memberFixture = await track(
      store.set(
        seedSlackOrgInstallation$,
        {
          orgId: memberOrgId,
          botScopes: JSON.stringify(["chat:write"]),
        },
        context.signal,
      ),
    );
    await store.set(
      seedSlackOrgConnection$,
      {
        slackWorkspaceId: memberFixture.slackWorkspaceId,
        vm0UserId: memberUserId,
      },
      context.signal,
    );
    mocks.clerk.session(memberUserId, memberOrgId, "org:member");
    const memberResponse = await accept(
      apiClient().getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(memberResponse.body.scopeMismatch).toBeUndefined();
    expect(memberResponse.body.reinstallUrl).toBeUndefined();

    // Given: an admin session + an installation
    // with a partial scope list but no user
    // connection.

    // When + Then: 200 — isConnected=false +
    // scopeMismatch=true + reinstallUrl includes
    // reinstall=1.
    const adminNoUserOrgId = `org_${randomUUID()}`;
    const adminNoUserUserId = `user_${randomUUID()}`;
    await track(
      store.set(
        seedSlackOrgInstallation$,
        {
          orgId: adminNoUserOrgId,
          botScopes: JSON.stringify(["chat:write"]),
        },
        context.signal,
      ),
    );
    mocks.clerk.session(adminNoUserUserId, adminNoUserOrgId, "org:admin");
    const adminNoUserResponse = await accept(
      apiClient().getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(adminNoUserResponse.body.isConnected).toBeFalsy();
    expect(adminNoUserResponse.body.scopeMismatch).toBeTruthy();
    expect(adminNoUserResponse.body.reinstallUrl).toContain("reinstall=1");
  });
});

function apiClient() {
  return setupApp({ context })(zeroIntegrationsSlackContract);
}
