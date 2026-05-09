import { randomUUID } from "node:crypto";

import { zeroIntegrationsSlackContract } from "@vm0/api-contracts/contracts/zero-integrations-slack";
import { createStore } from "ccstate";
import { beforeEach } from "vitest";

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

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

describe("GET /api/zero/integrations/slack", () => {
  const track = createFixtureTracker<SlackIntegrationFixture>((fixture) => {
    return store.set(deleteSlackIntegrationFixture$, fixture, context.signal);
  });

  beforeEach(() => {
    mockEnv("SLACK_CLIENT_ID", "test-slack-client-id");
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(zeroIntegrationsSlackContract);

    const response = await accept(client.getStatus({ headers: {} }), [401]);

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({ context })(zeroIntegrationsSlackContract);

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );

    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns isConnected=false when user has no connection", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    await track(
      store.set(seedSlackOrgInstallation$, { orgId }, context.signal),
    );
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroIntegrationsSlackContract);

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.isConnected).toBeFalsy();
  });

  it("returns workspace info for connected user", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const fixture = await track(
      store.set(seedSlackOrgInstallation$, { orgId }, context.signal),
    );
    await store.set(
      seedSlackOrgConnection$,
      { slackWorkspaceId: fixture.slackWorkspaceId, vm0UserId: userId },
      context.signal,
    );
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroIntegrationsSlackContract);

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.isConnected).toBeTruthy();
    expect(response.body.workspaceName).toBe("Test Org Workspace");
  });

  it("returns isAdmin=true for admin members", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const fixture = await track(
      store.set(seedSlackOrgInstallation$, { orgId }, context.signal),
    );
    await store.set(
      seedSlackOrgConnection$,
      { slackWorkspaceId: fixture.slackWorkspaceId, vm0UserId: userId },
      context.signal,
    );
    mocks.clerk.session(userId, orgId, "org:admin");

    const client = setupApp({ context })(zeroIntegrationsSlackContract);

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.isAdmin).toBeTruthy();
  });

  it("returns isAdmin=false for non-admin members", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const fixture = await track(
      store.set(seedSlackOrgInstallation$, { orgId }, context.signal),
    );
    await store.set(
      seedSlackOrgConnection$,
      { slackWorkspaceId: fixture.slackWorkspaceId, vm0UserId: userId },
      context.signal,
    );
    mocks.clerk.session(userId, orgId, "org:member");

    const client = setupApp({ context })(zeroIntegrationsSlackContract);

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.isAdmin).toBeFalsy();
  });

  it("returns environment info when connected", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const fixture = await track(
      store.set(seedSlackOrgInstallation$, { orgId }, context.signal),
    );
    await store.set(
      seedSlackOrgConnection$,
      { slackWorkspaceId: fixture.slackWorkspaceId, vm0UserId: userId },
      context.signal,
    );
    await store.set(
      seedSlackEnvironmentAgent$,
      { orgId, userId },
      context.signal,
    );
    mocks.clerk.session(userId, orgId);

    const client = setupApp({ context })(zeroIntegrationsSlackContract);

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.environment).toBeDefined();
    expect(response.body.environment?.requiredSecrets).toBeDefined();
    expect(response.body.environment?.requiredVars).toBeDefined();
    expect(response.body.environment?.missingSecrets).toBeDefined();
    expect(response.body.environment?.missingVars).toBeDefined();
  });

  it("returns scopeMismatch=false when installation has all required scopes", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const fullScopes = [
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
    ];
    const fixture = await track(
      store.set(
        seedSlackOrgInstallation$,
        { orgId, botScopes: JSON.stringify(fullScopes) },
        context.signal,
      ),
    );
    await store.set(
      seedSlackOrgConnection$,
      { slackWorkspaceId: fixture.slackWorkspaceId, vm0UserId: userId },
      context.signal,
    );
    mocks.clerk.session(userId, orgId, "org:admin");

    const client = setupApp({ context })(zeroIntegrationsSlackContract);

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.scopeMismatch).toBeFalsy();
    expect(response.body.reinstallUrl).toBeNull();
  });

  it("returns scopeMismatch=true when installation is missing scopes", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const fixture = await track(
      store.set(
        seedSlackOrgInstallation$,
        { orgId, botScopes: JSON.stringify(["chat:write", "channels:read"]) },
        context.signal,
      ),
    );
    await store.set(
      seedSlackOrgConnection$,
      { slackWorkspaceId: fixture.slackWorkspaceId, vm0UserId: userId },
      context.signal,
    );
    mocks.clerk.session(userId, orgId, "org:admin");

    const client = setupApp({ context })(zeroIntegrationsSlackContract);

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.scopeMismatch).toBeTruthy();
    expect(response.body.reinstallUrl).toContain(
      "/api/zero/slack/oauth/install",
    );
    expect(response.body.reinstallUrl).toContain("reinstall=1");
  });

  it("treats null bot_scopes as mismatch (requires reinstall)", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const fixture = await track(
      store.set(
        seedSlackOrgInstallation$,
        { orgId, botScopes: null },
        context.signal,
      ),
    );
    await store.set(
      seedSlackOrgConnection$,
      { slackWorkspaceId: fixture.slackWorkspaceId, vm0UserId: userId },
      context.signal,
    );
    mocks.clerk.session(userId, orgId, "org:admin");

    const client = setupApp({ context })(zeroIntegrationsSlackContract);

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.scopeMismatch).toBeTruthy();
  });

  it("does not expose scopeMismatch to non-admin users", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const fixture = await track(
      store.set(
        seedSlackOrgInstallation$,
        { orgId, botScopes: JSON.stringify(["chat:write"]) },
        context.signal,
      ),
    );
    await store.set(
      seedSlackOrgConnection$,
      { slackWorkspaceId: fixture.slackWorkspaceId, vm0UserId: userId },
      context.signal,
    );
    mocks.clerk.session(userId, orgId, "org:member");

    const client = setupApp({ context })(zeroIntegrationsSlackContract);

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.scopeMismatch).toBeUndefined();
    expect(response.body.reinstallUrl).toBeUndefined();
  });

  it("returns scopeMismatch for admin when user is not connected", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    await track(
      store.set(
        seedSlackOrgInstallation$,
        { orgId, botScopes: JSON.stringify(["chat:write"]) },
        context.signal,
      ),
    );
    mocks.clerk.session(userId, orgId, "org:admin");

    const client = setupApp({ context })(zeroIntegrationsSlackContract);

    const response = await accept(
      client.getStatus({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.isConnected).toBeFalsy();
    expect(response.body.scopeMismatch).toBeTruthy();
    expect(response.body.reinstallUrl).toContain("reinstall=1");
  });
});
