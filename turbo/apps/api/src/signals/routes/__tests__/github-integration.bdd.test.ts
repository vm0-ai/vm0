import { createHash, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { now } from "../../../lib/time";
import { testContext } from "../../../__tests__/test-helpers";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsAutomationsApi } from "./helpers/api-bdd-runs-automations";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import {
  GITHUB_APP_CLIENT_ID,
  GITHUB_APP_CLIENT_SECRET,
  GITHUB_APP_SLUG,
  GH_OAUTH_CLIENT_ID,
  GH_OAUTH_CLIENT_SECRET,
  acceptGithubRunObjectStorage,
  buildLegacySignedState,
  buildUserConnectState,
  captureChatCallbackDeliveries,
  captureGithubIssueApi,
  captureGithubIssuesCallbackDeliveries,
  connectLinkQuery,
  createGithubBddApi,
  mockClerkMembership,
  mockGithubAppEnv,
  mockGithubInstallationApi,
  mockGithubInstallationInfoFailure,
  mockGithubInstallationsList,
  mockGithubRemoteUninstall,
  mockGithubUserOAuthExchange,
  mockGithubUserOauthEnv,
  newGithubUserId,
  newRemoteInstallationId,
  proxyGithubIssuesCallbackToApp,
  signedConnectLink,
  zeroCapabilityToken,
  type RawRouteResponse,
} from "./helpers/api-bdd-github";

/**
 * CONN-02 / INT-03 / HOOK-01: GitHub App install + setup callback, GitHub
 * user OAuth linking, installation management, label listeners, and signed
 * internal issue callbacks produced by real webhook-created runs.
 */

const context = testContext();

const WEB_ORIGIN = "http://localhost:3001";
const APP_ORIGIN = "http://localhost:3002";
const SETUP_CALLBACK_PATH = "/api/github/app/setup/callback";

function orgOf(actor: ApiTestUser): string {
  if (!actor.orgId) {
    throw new Error("Expected an org-scoped actor");
  }
  return actor.orgId;
}

function redirectUrl(response: RawRouteResponse): URL {
  expect(response.status).toBe(307);
  if (!response.location) {
    throw new Error("Expected a redirect location header");
  }
  return new URL(response.location);
}

function expectWorksRedirect(response: RawRouteResponse, github: string): URL {
  const url = redirectUrl(response);
  expect(url.origin).toBe(APP_ORIGIN);
  expect(url.pathname).toBe("/works");
  expect(url.searchParams.get("github")).toBe(github);
  expect(url.searchParams.has("error")).toBeFalsy();
  return url;
}

function expectWorksError(response: RawRouteResponse, snippet: string): URL {
  const url = redirectUrl(response);
  expect(url.origin).toBe(APP_ORIGIN);
  expect(url.pathname).toBe("/works");
  expect(url.searchParams.get("error")).toContain(snippet);
  return url;
}

function bindingReference(namespace: "secrets" | "vars", name: string): string {
  return `\${{ ${namespace}.${name} }}`;
}

function installQueryFor(
  actor: ApiTestUser,
  composeId: string,
  options: { readonly orgId?: boolean } = {},
): string {
  return new URLSearchParams({
    vm0UserId: actor.userId,
    ...(options.orgId === false ? {} : { orgId: orgOf(actor) }),
    composeId,
  }).toString();
}

function parsedOauthState(url: URL): Record<string, unknown> {
  const state = url.searchParams.get("state");
  if (!state) {
    throw new Error("Expected the redirect to carry an OAuth state");
  }
  return JSON.parse(state) as Record<string, unknown>;
}

describe("CONN-02/INT-03 G1: GitHub App install and setup callback", () => {
  it("installs through the signed redirect, links the admin, and relinks on repeat installs", async () => {
    const bdd = createBddApi(context);
    const gh = createGithubBddApi(context);
    context.mocks.ably.publish.mockResolvedValue(undefined);

    const actor = bdd.user();
    const orgId = orgOf(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD GitHub Install Agent",
      visibility: "private",
    });
    mockGithubAppEnv();
    mockClerkMembership(context, actor, "org:admin");
    mockGithubInstallationsList([]);

    const installQuery = installQueryFor(actor, agent.agentId);
    const install = await gh.requestInstall(installQuery);
    const installUrl = redirectUrl(install);
    expect(installUrl.origin).toBe("https://github.com");
    expect(installUrl.pathname).toBe(
      `/apps/${GITHUB_APP_SLUG}/installations/new`,
    );
    expect(installUrl.searchParams.get("redirect_uri")).toBe(
      `${WEB_ORIGIN}${SETUP_CALLBACK_PATH}`,
    );
    expect(install.cacheControl).toBe("no-store");
    expect(parsedOauthState(installUrl)).toMatchObject({
      vm0UserId: actor.userId,
      orgId,
      composeId: agent.agentId,
      sig: expect.any(String),
    });
    const state = installUrl.searchParams.get("state");
    if (!state) {
      throw new Error("Expected the install redirect to carry a state");
    }

    const remoteInstallationId = newRemoteInstallationId();
    const targetId = newGithubUserId();
    const adminGithubUserId = newGithubUserId();
    mockGithubInstallationApi({
      installationId: remoteInstallationId,
      targetId,
      login: "bdd-org",
      type: "Organization",
    });
    const exchange = mockGithubUserOAuthExchange({
      code: "g1-setup-code",
      githubUserId: adminGithubUserId,
    });

    const callback = await gh.requestSetupCallback(
      new URLSearchParams({
        installation_id: remoteInstallationId,
        setup_action: "install",
        code: "g1-setup-code",
        state,
      }).toString(),
    );
    expectWorksRedirect(callback, "connected");
    expect(exchange).toMatchObject({
      calls: 1,
      clientId: GITHUB_APP_CLIENT_ID,
      clientSecret: GITHUB_APP_CLIENT_SECRET,
      code: "g1-setup-code",
      hasRedirectUri: false,
    });

    const agentName = await gh.readComposeName(actor, agent.agentId);
    const installation = await gh.readInstallation(actor);
    expect(installation.installation).toMatchObject({
      installationId: remoteInstallationId,
      status: "active",
      targetName: "bdd-org",
      targetType: "Organization",
      isAdmin: true,
    });
    expect(installation.isConnected).toBeTruthy();
    expect(installation.connectedGithubUserId).toBe(adminGithubUserId);
    expect(installation.connectedGithubUsername).toBe("octocat");
    expect(installation.agent).toStrictEqual({
      id: agent.agentId,
      name: agentName,
    });
    expect(installation.labelListeners).toStrictEqual([]);
    // Zero-agent composes always reference the runtime-injected bindings.
    expect(installation.environment).toStrictEqual({
      requiredSecrets: ["ZERO_TOKEN"],
      requiredVars: ["ZERO_AGENT_ID"],
      missingSecrets: ["ZERO_TOKEN"],
      missingVars: ["ZERO_AGENT_ID"],
    });
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "github:changed",
      null,
    );

    // Repeat install links from the local active record without GitHub calls.
    const reinstall = await gh.requestInstall(installQuery);
    expectWorksRedirect(reinstall, "connected");

    // Repeat setup callback without a code reuses the existing installation
    // and links through the stored GitHub connector.
    const repeatCallback = await gh.requestSetupCallback(
      new URLSearchParams({
        installation_id: remoteInstallationId,
        setup_action: "install",
        state,
      }).toString(),
    );
    expectWorksRedirect(repeatCallback, "connected");
  });

  it("adopts an unclaimed remote installation during install", async () => {
    const bdd = createBddApi(context);
    const gh = createGithubBddApi(context);

    const actor = bdd.user();
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD GitHub Adoption Agent",
      visibility: "private",
    });
    mockGithubAppEnv();
    mockClerkMembership(context, actor, "org:admin");

    const remoteInstallationId = newRemoteInstallationId();
    const targetId = newGithubUserId();
    mockGithubInstallationsList([
      { id: remoteInstallationId, targetId, login: "bdd-user", type: "User" },
    ]);
    mockGithubInstallationApi({
      installationId: remoteInstallationId,
      targetId,
      login: "bdd-user",
      type: "User",
    });

    const adopted = await gh.requestInstall(
      installQueryFor(actor, agent.agentId),
    );
    expectWorksRedirect(adopted, "connected");

    const installation = await gh.readInstallation(actor);
    expect(installation.installation).toMatchObject({
      installationId: remoteInstallationId,
      status: "active",
      targetName: "bdd-user",
      targetType: "User",
      isAdmin: true,
    });
    expect(installation.isConnected).toBeTruthy();
    expect(installation.connectedGithubUserId).toBe(targetId);
    expect(installation.connectedGithubUsername).toBeNull();
    expect(installation.agent?.id).toBe(agent.agentId);
  });
});

describe("CONN-02 G2: GitHub user OAuth connect and linking", () => {
  it("connects, reconnects, disconnects, and relinks users through OAuth and signed links", async () => {
    const bdd = createBddApi(context);
    const gh = createGithubBddApi(context);

    const actor = bdd.user();
    const orgId = orgOf(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD GitHub Connect Agent",
      visibility: "private",
    });
    mockGithubUserOauthEnv();
    const install = await gh.installGithubApp(actor, agent.agentId);

    // Connect start redirects to the GitHub authorize URL.
    const start = await gh.requestConnect(actor, "");
    const authorizeUrl = redirectUrl(start);
    expect(authorizeUrl.origin).toBe("https://github.com");
    expect(authorizeUrl.pathname).toBe("/login/oauth/authorize");
    expect(authorizeUrl.searchParams.get("client_id")).toBe(GH_OAUTH_CLIENT_ID);
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(
      `${WEB_ORIGIN}/api/connectors/github/callback`,
    );
    expect(authorizeUrl.searchParams.get("scope")).toBe(
      "repo project workflow",
    );
    expect(authorizeUrl.searchParams.get("state")).toMatch(/^[0-9a-f]{64}$/u);
    expect(start.cacheControl).toBe("no-store");

    // OAuth callback exchanges the code and links the user.
    const firstGithubUserId = newGithubUserId();
    const firstExchange = mockGithubUserOAuthExchange({
      code: "g2-code-1",
      githubUserId: firstGithubUserId,
    });
    const connectState = buildUserConnectState({
      userId: actor.userId,
      orgId,
    });
    const callback = await gh.requestConnectCallback(
      `code=g2-code-1&state=${encodeURIComponent(connectState)}`,
    );
    expectWorksRedirect(callback, "connected");
    expect(firstExchange).toMatchObject({
      clientId: GH_OAUTH_CLIENT_ID,
      clientSecret: GH_OAUTH_CLIENT_SECRET,
      code: "g2-code-1",
      redirectUri: `${WEB_ORIGIN}/api/zero/github/oauth/connect/callback`,
    });
    const connected = await gh.readInstallation(actor);
    expect(connected.isConnected).toBeTruthy();
    expect(connected.connectedGithubUserId).toBe(firstGithubUserId);
    expect(connected.connectedGithubUsername).toBe("octocat");

    // Reconnecting with a different GitHub account replaces the link.
    const nextGithubUserId = newGithubUserId();
    mockGithubUserOAuthExchange({
      code: "g2-code-2",
      githubUserId: nextGithubUserId,
    });
    const reconnect = await gh.requestConnectCallback(
      `code=g2-code-2&state=${encodeURIComponent(connectState)}`,
    );
    expectWorksRedirect(reconnect, "connected");
    const reconnected = await gh.readInstallation(actor);
    expect(reconnected.connectedGithubUserId).toBe(nextGithubUserId);

    // Disconnect removes the link but keeps the GitHub connector.
    await gh.disconnectUser(actor, [200]);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "github:changed",
      null,
    );
    const disconnected = await gh.readInstallation(actor);
    expect(disconnected.isConnected).toBeFalsy();
    expect(disconnected.connectedGithubUserId).toBeNull();
    expect(disconnected.connectedGithubUsername).toBeNull();
    const reconnectUrl = new URL(disconnected.connectUrl);
    expect(reconnectUrl.origin).toBe("https://github.com");
    expect(reconnectUrl.pathname).toBe("/login/oauth/authorize");
    const connector = await gh.readGithubConnector(actor);
    expect(connector.externalId).toBe(nextGithubUserId);
    expect(connector.externalUsername).toBe("octocat");

    // POST /link without a signature relinks via the surviving connector.
    await gh.connectUser(actor, {}, [200]);
    const relinked = await gh.readInstallation(actor);
    expect(relinked.isConnected).toBeTruthy();
    expect(relinked.connectedGithubUserId).toBe(nextGithubUserId);
    expect(relinked.connectUrl).toBe(
      `${WEB_ORIGIN}/api/zero/github/oauth/connect`,
    );

    // A signed mention link connects a member through the connect route.
    const memberOne = bdd.user({ orgId, orgRole: "org:member" });
    const memberOneGithubUserId = newGithubUserId();
    const mentionLink = signedConnectLink({
      installationId: install.remoteInstallationId,
      githubUserId: memberOneGithubUserId,
    });
    const linked = await gh.requestConnect(
      memberOne,
      connectLinkQuery(mentionLink),
    );
    expectWorksRedirect(linked, "connected");
    const memberOneView = await gh.readInstallation(memberOne);
    expect(memberOneView.isConnected).toBeTruthy();
    expect(memberOneView.connectedGithubUserId).toBe(memberOneGithubUserId);

    // A signed connect body links another member through POST /link.
    const memberTwo = bdd.user({ orgId, orgRole: "org:member" });
    const bodyLink = signedConnectLink({
      installationId: install.remoteInstallationId,
      githubUserId: newGithubUserId(),
      githubUsername: "hubber",
    });
    await gh.connectUser(memberTwo, { connectSignature: bodyLink }, [200]);
    const memberTwoView = await gh.readInstallation(memberTwo);
    expect(memberTwoView.isConnected).toBeTruthy();
    expect(memberTwoView.connectedGithubUserId).toBe(bodyLink.githubUserId);

    // Expired mention links are rejected without linking.
    const memberThree = bdd.user({ orgId, orgRole: "org:member" });
    const expiredLink = signedConnectLink({
      installationId: install.remoteInstallationId,
      githubUserId: newGithubUserId(),
      ageSeconds: 11 * 60,
    });
    const rejected = await gh.requestConnect(
      memberThree,
      connectLinkQuery(expiredLink),
    );
    expectWorksError(rejected, "Invalid or expired GitHub connect link");
    const memberThreeView = await gh.readInstallation(memberThree);
    expect(memberThreeView.isConnected).toBeFalsy();
  });
});

describe("CONN-02 G3: install and setup-callback boundary matrix", () => {
  it("returns 503 when the GitHub App slug is not configured", async () => {
    const gh = createGithubBddApi(context);
    mockGithubAppEnv({ slug: false });

    const response = await gh.requestInstall("");

    expect(response.status).toBe(503);
    expect(response.body).toStrictEqual({
      error: "GitHub App integration is not configured",
    });
  });

  it("redirects installs without query parameters to GitHub without state", async () => {
    const gh = createGithubBddApi(context);
    mockGithubAppEnv({ credentials: false });

    const response = await gh.requestInstall("");

    const url = redirectUrl(response);
    expect(url.origin).toBe("https://github.com");
    expect(url.pathname).toBe(`/apps/${GITHUB_APP_SLUG}/installations/new`);
    expect(url.searchParams.has("state")).toBeFalsy();
    expect(url.searchParams.get("redirect_uri")).toBe(
      `${WEB_ORIGIN}${SETUP_CALLBACK_PATH}`,
    );
  });

  it("redirects API-host install and callback requests to the canonical web route", async () => {
    const gh = createGithubBddApi(context);
    mockGithubAppEnv({ credentials: false });

    const installPath =
      "/api/github/oauth/install?vm0UserId=user-1&composeId=compose-1";
    const install = await gh.requestInstall(
      "vm0UserId=user-1&composeId=compose-1",
      { origin: "https://api.vm0.ai" },
    );
    expect(install.status).toBe(307);
    expect(install.location).toBe(`https://www.vm0.ai${installPath}`);
    expect(install.cacheControl).toBe("no-store");

    const callbackPath = `${SETUP_CALLBACK_PATH}?installation_id=12345&setup_action=update`;
    const callback = await gh.requestSetupCallback(
      "installation_id=12345&setup_action=update",
      { origin: "https://api.vm0.ai" },
    );
    expect(callback.status).toBe(307);
    expect(callback.location).toBe(`https://www.vm0.ai${callbackPath}`);
    expect(callback.cacheControl).toBe("no-store");
  });

  it("honors trusted web-origin headers and ignores untrusted ones", async () => {
    const gh = createGithubBddApi(context);
    mockEnv("VM0_WEB_URL", "https://www.vm0.ai");
    mockGithubAppEnv({ credentials: false });

    const trusted = await gh.requestInstall(
      "vm0UserId=user-1&composeId=compose-1",
      {
        origin: "https://api.vm0.ai",
        webOriginHeader: "https://www.vm0.ai",
      },
    );
    const trustedUrl = redirectUrl(trusted);
    expect(trustedUrl.origin).toBe("https://github.com");
    expect(trustedUrl.searchParams.get("redirect_uri")).toBe(
      `https://www.vm0.ai${SETUP_CALLBACK_PATH}`,
    );

    const untrusted = await gh.requestInstall("", {
      webOriginHeader: "https://evil.example",
    });
    const untrustedUrl = redirectUrl(untrusted);
    expect(untrustedUrl.origin).toBe("https://github.com");
    expect(untrustedUrl.searchParams.get("redirect_uri")).toBe(
      `https://www.vm0.ai${SETUP_CALLBACK_PATH}`,
    );
  });

  it("rejects GitHub App installs for org members", async () => {
    const bdd = createBddApi(context);
    const gh = createGithubBddApi(context);
    const member = bdd.user();
    mockGithubAppEnv();
    mockClerkMembership(context, member, "org:member");

    const response = await gh.requestInstall(
      installQueryFor(member, randomUUID()),
    );

    const url = expectWorksError(response, "");
    expect(url.searchParams.get("error")).toBe(
      "Only organization admins can install GitHub",
    );
  });

  it("does not link installations that belong to another organization", async () => {
    const bdd = createBddApi(context);
    const gh = createGithubBddApi(context);

    const owner = bdd.user();
    const ownerAgent = await bdd.createAgent(owner, {
      displayName: "BDD Cross-Org Owner Agent",
      visibility: "private",
    });
    const foreign = await gh.installGithubApp(owner, ownerAgent.agentId);

    const actor = bdd.user();
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD Cross-Org Actor Agent",
      visibility: "private",
    });
    mockClerkMembership(context, actor, "org:admin");
    mockGithubInstallationsList([
      { id: foreign.remoteInstallationId, targetId: foreign.targetId },
    ]);

    const response = await gh.requestInstall(
      installQueryFor(actor, agent.agentId),
    );

    const url = redirectUrl(response);
    expect(url.origin).toBe("https://github.com");
    expect(url.pathname).toBe(`/apps/${GITHUB_APP_SLUG}/installations/new`);
    const missing = await gh.requestReadInstallation(actor, [404]);
    expect(missing.body.error.code).toBe("NOT_FOUND");
  });

  it("redirects setup-callback failures to /works with error messages", async () => {
    const gh = createGithubBddApi(context);

    mockGithubAppEnv({ credentials: false });
    const missingCredentials = await gh.requestSetupCallback("");
    expectWorksError(
      missingCredentials,
      "GitHub App integration is not configured",
    );

    mockGithubAppEnv();
    const update = await gh.requestSetupCallback(
      "installation_id=12345&setup_action=update",
    );
    expectWorksRedirect(update, "installed");

    const invalidJson = await gh.requestSetupCallback(
      "installation_id=12345&setup_action=install&state=not-json",
    );
    expectWorksError(invalidJson, "Invalid OAuth state");

    const badSignatureState = JSON.stringify({
      vm0UserId: "user-123",
      composeId: "compose-123",
      sig: "invalid-signature",
    });
    const badSignature = await gh.requestSetupCallback(
      `installation_id=12345&setup_action=install&state=${encodeURIComponent(badSignatureState)}`,
    );
    expectWorksError(badSignature, "Invalid state signature");

    const missingCompose = await gh.requestSetupCallback(
      "installation_id=12345&setup_action=install",
    );
    expectWorksError(missingCompose, "Missing default agent");
  });

  it("accepts legacy-signed states for request actions and missing installation ids", async () => {
    const bdd = createBddApi(context);
    const gh = createGithubBddApi(context);
    const actor = bdd.user();
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD Legacy State Agent",
      visibility: "private",
    });
    mockGithubAppEnv();
    const legacyState = buildLegacySignedState({
      userId: actor.userId,
      composeId: agent.agentId,
    });

    const requestAction = await gh.requestSetupCallback(
      new URLSearchParams({
        setup_action: "request",
        target_id: "777888999",
        target_type: "Organization",
        state: legacyState,
      }).toString(),
    );
    const requestUrl = redirectUrl(requestAction);
    expect(requestUrl.searchParams.get("error")).toBe(
      "You don't have permission to install this GitHub App. Ask a GitHub organization owner to install it, then try again.",
    );
    expect(requestUrl.searchParams.has("github")).toBeFalsy();

    const missingInstallation = await gh.requestSetupCallback(
      new URLSearchParams({
        setup_action: "install",
        state: legacyState,
      }).toString(),
    );
    expectWorksError(missingInstallation, "Missing installation ID");

    const stillMissing = await gh.requestReadInstallation(actor, [404]);
    expect(stillMissing.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 500 when the GitHub installation info request fails", async () => {
    const bdd = createBddApi(context);
    const gh = createGithubBddApi(context);
    const actor = bdd.user();
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD Install Failure Agent",
      visibility: "private",
    });
    mockGithubAppEnv();
    mockGithubInstallationsList([]);

    const install = await gh.requestInstall(
      installQueryFor(actor, agent.agentId, { orgId: false }),
    );
    const state = redirectUrl(install).searchParams.get("state");
    if (!state) {
      throw new Error("Expected the install redirect to carry a state");
    }

    mockGithubInstallationInfoFailure(401);
    const response = await gh.requestSetupCallback(
      new URLSearchParams({
        installation_id: newRemoteInstallationId(),
        setup_action: "install",
        state,
      }).toString(),
    );

    expect(response.status).toBe(500);
    expect(response.body).toStrictEqual({ error: "Internal server error" });
  });

  it("redirects unauthenticated connect starts to sign-in", async () => {
    const gh = createGithubBddApi(context);

    const response = await gh.requestConnect(null, "");

    const url = redirectUrl(response);
    expect(url.pathname).toBe("/sign-in");
    expect(url.searchParams.get("redirect_url")).toBe(
      "http://localhost:3000/api/zero/github/oauth/connect",
    );
  });
});

describe("INT-03 G4: installation management", () => {
  it("manages the default agent, member permissions, and deletion", async () => {
    const bdd = createBddApi(context);
    const gh = createGithubBddApi(context);

    const actor = bdd.user();
    const orgId = orgOf(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD GitHub Manager Agent",
      visibility: "private",
    });
    const install = await gh.installGithubApp(actor, agent.agentId, {
      oauthCode: { code: "g4-code", githubUserId: newGithubUserId() },
    });

    const composeName = `github-bdd-env-${randomUUID().slice(0, 8)}`;
    const composeB = await gh.createCompose(actor, {
      version: "1",
      agents: {
        [composeName]: {
          framework: "claude-code",
          environment: {
            PRESENT_SECRET: bindingReference("secrets", "PRESENT_SECRET"),
            MISSING_SECRET: bindingReference("secrets", "MISSING_SECRET"),
            GITHUB_TOKEN: bindingReference("secrets", "GITHUB_TOKEN"),
            PRESENT_VAR: bindingReference("vars", "PRESENT_VAR"),
            MISSING_VAR: bindingReference("vars", "MISSING_VAR"),
          },
        },
      },
    });
    await gh.setSecret(actor, "PRESENT_SECRET", "present-secret-value");
    await gh.setVariable(actor, "PRESENT_VAR", "ready");

    await gh.updateInstallation(actor, composeB.name, [200]);
    const updated = await gh.readInstallation(actor);
    expect(updated.agent).toStrictEqual({
      id: composeB.composeId,
      name: composeB.name,
    });
    expect(updated.environment.requiredSecrets).toStrictEqual(
      expect.arrayContaining([
        "PRESENT_SECRET",
        "MISSING_SECRET",
        "GITHUB_TOKEN",
      ]),
    );
    expect(updated.environment.requiredVars).toStrictEqual(
      expect.arrayContaining(["PRESENT_VAR", "MISSING_VAR"]),
    );
    expect(updated.environment.missingSecrets).toStrictEqual([
      "MISSING_SECRET",
    ]);
    expect(updated.environment.missingVars).toStrictEqual(["MISSING_VAR"]);

    // Web-origin headers are ignored when building admin install URLs.
    const headerView = await gh.requestReadInstallation(actor, [200], {
      webOriginHeader: "https://evil.example",
    });
    const headerInstallUrl = headerView.body.installUrl;
    if (!headerInstallUrl) {
      throw new Error("Expected an install URL for the org admin");
    }
    expect(new URL(headerInstallUrl).searchParams.get("redirect_uri")).toBe(
      `${WEB_ORIGIN}${SETUP_CALLBACK_PATH}`,
    );

    await gh.updateInstallation(
      actor,
      `missing-agent-${randomUUID().slice(0, 8)}`,
      [404],
    );
    const agentNameRequired = {
      error: { message: "agentName is required", code: "BAD_REQUEST" },
    };
    const emptyBody = await gh.rawUpdateInstallation(actor, JSON.stringify({}));
    expect(emptyBody.status).toBe(400);
    expect(emptyBody.body).toStrictEqual(agentNameRequired);
    const invalidJson = await gh.rawUpdateInstallation(actor, "{");
    expect(invalidJson.status).toBe(400);
    expect(invalidJson.body).toStrictEqual(agentNameRequired);
    const emptyName = await gh.rawUpdateInstallation(
      actor,
      JSON.stringify({ agentName: "" }),
    );
    expect(emptyName.status).toBe(400);
    expect(emptyName.body).toStrictEqual(agentNameRequired);

    const member = bdd.user({ orgId, orgRole: "org:member" });
    const memberView = await gh.readInstallation(member);
    expect(memberView.installUrl).toBeNull();
    expect(memberView.installation.isAdmin).toBeFalsy();
    expect(memberView.isConnected).toBeFalsy();
    await gh.updateInstallation(member, composeB.name, [403]);
    await gh.deleteInstallation(member, [403]);
    const survivedMemberDelete = await gh.readInstallation(member);
    expect(survivedMemberDelete.installation.status).toBe("active");

    // Admin deletion stays authoritative when the remote uninstall fails.
    await gh.setDefaultAgent(actor, agent.agentId);
    const recordedUninstall = mockGithubRemoteUninstall();
    await gh.deleteInstallation(actor, [200]);
    expect(recordedUninstall.installationId).toBe(install.remoteInstallationId);
    expect(recordedUninstall.authorization).toMatch(/^Bearer .+/u);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "github:changed",
      null,
    );

    const afterDelete = await gh.requestReadInstallation(actor, [404]);
    expect(afterDelete.body.error).toStrictEqual({
      message: "No GitHub installation found",
      code: "NOT_FOUND",
    });
    const installUrlValue = afterDelete.body.installUrl;
    if (!installUrlValue) {
      throw new Error("Expected a post-delete install URL for the org admin");
    }
    const installUrl = new URL(installUrlValue);
    expect(installUrl.origin).toBe("https://github.com");
    expect(installUrl.pathname).toBe(
      `/apps/${GITHUB_APP_SLUG}/installations/new`,
    );
    expect(parsedOauthState(installUrl)).toMatchObject({
      vm0UserId: actor.userId,
      orgId,
      composeId: agent.agentId,
      sig: expect.any(String),
    });
  });

  it("rejects unauthenticated, org-less, and installation-less management requests", async () => {
    const bdd = createBddApi(context);
    const gh = createGithubBddApi(context);

    const unauthenticated = await gh.requestReadInstallation(null, [401]);
    expect(unauthenticated.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
    await gh.updateInstallation(null, "agent", [401]);
    await gh.deleteInstallation(null, [401]);
    await gh.connectUser(null, {}, [401]);
    await gh.disconnectUser(null, [401]);

    const orgless = bdd.user({ orgId: null });
    const orglessRead = await gh.requestReadInstallation(orgless, [400]);
    expect(orglessRead.body).toStrictEqual({
      error: {
        message: "Explicit org context required — ensure active org in session",
        code: "BAD_REQUEST",
      },
    });
    await gh.updateInstallation(orgless, "agent", [400]);

    const fresh = bdd.user();
    const freshRead = await gh.requestReadInstallation(fresh, [404]);
    expect(freshRead.body.error.code).toBe("NOT_FOUND");
    expect(freshRead.body.installUrl).toBeNull();
    await gh.updateInstallation(fresh, "agent", [404]);
    await gh.deleteInstallation(fresh, [404]);
    await gh.connectUser(fresh, {}, [404]);
    await gh.disconnectUser(fresh, [404]);
  });
});

describe("INT-03 G5: label listeners and capability tokens", () => {
  it("manages label listeners across roles and zero capability tokens", async () => {
    const bdd = createBddApi(context);
    const api = createRunsAutomationsApi(context);
    const gh = createGithubBddApi(context);

    const actor = bdd.user();
    const orgId = orgOf(actor);
    bdd.acceptAgentStorageWrites();
    api.acceptStorageDownloads();
    api.acceptTelemetryIngest();
    const runnerGroup = api.configureRunnerGroup();
    await api.grantProEntitlement(actor);
    await api.ensureOrgModelProvider(actor);
    const agentA = await bdd.createAgent(actor, {
      displayName: "BDD GitHub Listener Agent",
      visibility: "private",
    });
    const agentB = await bdd.createAgent(actor, {
      displayName: "BDD GitHub Listener Agent B",
      visibility: "private",
    });
    const install = await gh.installGithubApp(actor, agentA.agentId, {
      oauthCode: { code: "g5-code", githubUserId: newGithubUserId() },
    });

    const ownerMember = bdd.user({ orgId, orgRole: "org:member" });
    const ownerLink = signedConnectLink({
      installationId: install.remoteInstallationId,
      githubUserId: newGithubUserId(),
    });
    await gh.connectUser(ownerMember, { connectSignature: ownerLink }, [200]);

    const created = await gh.createLabelListener(
      ownerMember,
      {
        labelName: "Ready For Zero",
        triggerMode: "anyone",
        prompt: "Handle this issue",
        agentId: agentA.agentId,
      },
      [201],
    );
    const listenerId = created.body.listener.id;
    expect(created.body.listener).toMatchObject({
      labelName: "Ready For Zero",
      triggerMode: "anyone",
      enabled: true,
      canManage: true,
      agent: { id: agentA.agentId },
    });

    const adminListener = await gh.createLabelListener(
      actor,
      {
        labelName: "Escalations",
        triggerMode: "anyone",
        prompt: "Escalate this issue",
        agentId: agentA.agentId,
      },
      [201],
    );
    const adminListenerId = adminListener.body.listener.id;

    const memberRead = await gh.readInstallation(ownerMember);
    expect(
      memberRead.labelListeners.map((listener) => {
        return { labelName: listener.labelName, canManage: listener.canManage };
      }),
    ).toStrictEqual([
      { labelName: "Escalations", canManage: false },
      { labelName: "Ready For Zero", canManage: true },
    ]);
    const adminRead = await gh.readInstallation(actor);
    expect(
      adminRead.labelListeners.map((listener) => {
        return listener.canManage;
      }),
    ).toStrictEqual([true, true]);

    // Duplicate labels are rejected after normalization.
    await gh.createLabelListener(
      ownerMember,
      {
        labelName: " ready for zero ",
        triggerMode: "anyone",
        prompt: "Handle it again",
        agentId: agentA.agentId,
      },
      [409],
    );

    await gh.updateLabelListener(
      ownerMember,
      listenerId,
      {
        labelName: "Needs Agent",
        prompt: "Review and fix",
        triggerMode: "created_by_me",
        enabled: false,
        agentId: agentB.agentId,
      },
      [200],
    );
    const afterUpdate = await gh.readInstallation(ownerMember);
    const updatedListener = afterUpdate.labelListeners.find((listener) => {
      return listener.id === listenerId;
    });
    expect(updatedListener).toMatchObject({
      labelName: "Needs Agent",
      triggerMode: "created_by_me",
      prompt: "Review and fix",
      enabled: false,
      agent: { id: agentB.agentId },
    });

    // Renaming onto another listener's label collides.
    await gh.updateLabelListener(
      ownerMember,
      listenerId,
      { labelName: " ESCALATIONS " },
      [409],
    );

    const otherMember = bdd.user({ orgId, orgRole: "org:member" });
    await gh.updateLabelListener(
      otherMember,
      listenerId,
      { enabled: true },
      [403],
    );
    await gh.deleteLabelListener(otherMember, listenerId, [403]);
    await gh.createLabelListener(
      otherMember,
      {
        labelName: "Mine Only",
        triggerMode: "created_by_me",
        prompt: "Only my issues",
        agentId: agentA.agentId,
      },
      [409],
    );

    await gh.updateLabelListener(actor, listenerId, { enabled: true }, [200]);
    await gh.deleteLabelListener(actor, listenerId, [200]);
    const afterDelete = await gh.readInstallation(actor);
    expect(
      afterDelete.labelListeners.map((listener) => {
        return listener.id;
      }),
    ).toStrictEqual([adminListenerId]);

    // A claimed run's real ZERO_TOKEN manages the integration by capability.
    mockClerkMembership(context, actor, "org:admin");
    const run = await api.createRun(actor, {
      agentId: agentA.agentId,
      prompt: "github capability run",
      modelProvider: "anthropic-api-key",
    });
    await api.heartbeatRunner(runnerGroup);
    const claim = await api.claimRunnerJob(run.runId);
    const zeroToken = claim.environment?.ZERO_TOKEN;
    if (!zeroToken) {
      throw new Error("Expected the claimed run to expose a ZERO_TOKEN");
    }
    const tokenAuth = { bearer: zeroToken };

    const tokenRead = await gh.requestReadInstallation(tokenAuth, [200]);
    expect(tokenRead.body.installation.installationId).toBe(
      install.remoteInstallationId,
    );
    const tokenCreated = await gh.createLabelListener(
      tokenAuth,
      {
        labelName: "Zero Managed",
        triggerMode: "anyone",
        prompt: "Token listener",
        agentId: agentA.agentId,
      },
      [201],
    );
    const tokenListenerId = tokenCreated.body.listener.id;
    await gh.updateLabelListener(
      tokenAuth,
      tokenListenerId,
      { prompt: "Token listener updated" },
      [200],
    );
    await gh.deleteLabelListener(tokenAuth, tokenListenerId, [200]);

    await api.requestCancelRun(actor, run.runId, [200]);
    const cancelled = await api.readRun(actor, run.runId);
    expect(cancelled.status).toBe("cancelled");
  });

  it("rejects zero tokens lacking the required GitHub capabilities", async () => {
    const gh = createGithubBddApi(context);

    const writeOnly = zeroCapabilityToken({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      capabilities: ["github:write"],
    });
    const deniedRead = await gh.requestReadInstallation(
      { bearer: writeOnly },
      [403],
    );
    expect(deniedRead.body).toStrictEqual({
      error: {
        message: "Missing required capability: github:read",
        code: "FORBIDDEN",
      },
    });

    const readOnly = zeroCapabilityToken({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      capabilities: ["github:read"],
    });
    const deniedWrite = await gh.createLabelListener(
      { bearer: readOnly },
      {
        labelName: "Ready",
        triggerMode: "anyone",
        prompt: "Handle this issue",
        agentId: randomUUID(),
      },
      [403],
    );
    expect(deniedWrite.body).toStrictEqual({
      error: {
        message: "Missing required capability: github:write",
        code: "FORBIDDEN",
      },
    });
  });
});

interface GithubRunHarness {
  readonly bdd: ReturnType<typeof createBddApi>;
  readonly api: ReturnType<typeof createRunsAutomationsApi>;
  readonly webhooks: ReturnType<typeof createWebhookCallbackApi>;
  readonly gh: ReturnType<typeof createGithubBddApi>;
  readonly actor: ApiTestUser;
  readonly runnerGroup: string;
  readonly defaultAgentId: string;
  readonly secondAgentId: string;
  readonly remoteInstallationId: string;
  readonly issueApi: ReturnType<typeof captureGithubIssueApi>;
}

async function githubRunActor(
  senderGithubUserId: string,
): Promise<GithubRunHarness> {
  const bdd = createBddApi(context);
  const api = createRunsAutomationsApi(context);
  const webhooks = createWebhookCallbackApi(context);
  const gh = createGithubBddApi(context);

  const actor = bdd.user();
  acceptGithubRunObjectStorage(context);
  api.acceptStorageDownloads();
  api.acceptTelemetryIngest();
  const runnerGroup = api.configureRunnerGroup();
  await api.grantProEntitlement(actor);
  await api.ensureOrgModelProvider(actor);

  const defaultAgent = await bdd.createAgent(actor, {
    displayName: "Default GitHub Agent",
    visibility: "private",
  });
  const secondAgent = await bdd.createAgent(actor, {
    displayName: "GitHub Agent",
    visibility: "private",
  });
  const install = await gh.installGithubApp(actor, defaultAgent.agentId, {
    oauthCode: {
      code: `g6-code-${randomUUID().slice(0, 8)}`,
      githubUserId: senderGithubUserId,
    },
  });
  webhooks.configureGithubWebhookSecret();
  const issueApi = captureGithubIssueApi(install.remoteInstallationId);

  return {
    bdd,
    api,
    webhooks,
    gh,
    actor,
    runnerGroup,
    defaultAgentId: defaultAgent.agentId,
    secondAgentId: secondAgent.agentId,
    remoteInstallationId: install.remoteInstallationId,
    issueApi,
  };
}

interface GithubWebhookSender {
  readonly githubUserId: string;
  readonly login?: string;
}

function webhookSender(sender: GithubWebhookSender): {
  readonly id: number;
  readonly login: string;
  readonly type: string;
} {
  return {
    id: Number(sender.githubUserId),
    login: sender.login ?? "octocat",
    type: "User",
  };
}

function issuesLabeledEvent(args: {
  readonly remoteInstallationId: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly labelName: string;
  readonly sender: GithubWebhookSender;
}): string {
  const sender = webhookSender(args.sender);
  return JSON.stringify({
    action: "labeled",
    issue: {
      number: args.issueNumber,
      title: `BDD issue ${args.issueNumber}`,
      body: "Please handle this issue.",
      labels: [{ id: 1, name: args.labelName }],
      user: sender,
    },
    label: { id: 1, name: args.labelName },
    repository: { full_name: args.repo },
    installation: { id: Number(args.remoteInstallationId) },
    sender,
  });
}

interface GithubSubjectEventArgs {
  readonly remoteInstallationId: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly action: string;
  readonly labels: readonly string[];
  readonly label?: string;
  readonly issueTitle?: string;
  readonly issueBody?: string | null;
  readonly issueUser?: GithubWebhookSender;
  readonly sender: GithubWebhookSender;
}

function githubSubjectEvent(
  subjectKey: "issue" | "pull_request",
  args: GithubSubjectEventArgs,
): string {
  const sender = webhookSender(args.sender);
  const issueUser = webhookSender(args.issueUser ?? args.sender);
  return JSON.stringify({
    action: args.action,
    [subjectKey]: {
      number: args.issueNumber,
      title: args.issueTitle ?? `BDD issue ${args.issueNumber}`,
      body:
        args.issueBody === undefined
          ? "Please handle this issue."
          : args.issueBody,
      labels: args.labels.map((name, index) => {
        return { id: index + 1, name };
      }),
      user: issueUser,
    },
    ...(args.label === undefined ? {} : { label: { id: 1, name: args.label } }),
    repository: { full_name: args.repo },
    installation: { id: Number(args.remoteInstallationId) },
    sender,
  });
}

function issuesEvent(args: GithubSubjectEventArgs): string {
  return githubSubjectEvent("issue", args);
}

function pullRequestEvent(args: GithubSubjectEventArgs): string {
  return githubSubjectEvent("pull_request", args);
}

function installationEvent(args: {
  readonly action: string;
  readonly installationId: string;
  readonly targetId: string;
}): string {
  return JSON.stringify({
    action: args.action,
    installation: {
      id: Number(args.installationId),
      account: {
        id: Number(args.targetId),
        login: "bdd-org",
        type: "Organization",
      },
    },
    sender: { id: 4242, login: "bdd-sender" },
  });
}

type CapturedIssueComment = {
  readonly body: string;
};

type CapturedIssueApi = {
  readonly comments: readonly CapturedIssueComment[];
};

function latestComment(issueApi: CapturedIssueApi): CapturedIssueComment {
  const comment = issueApi.comments[issueApi.comments.length - 1];
  if (!comment) {
    throw new Error("Expected a captured GitHub issue comment");
  }
  return comment;
}

async function waitForCommentCount(
  issueApi: CapturedIssueApi,
  count: number,
): Promise<void> {
  await expect
    .poll(() => {
      return issueApi.comments.length;
    })
    .toBe(count);
}

async function waitForCommentContaining(
  issueApi: CapturedIssueApi,
  text: string,
  startIndex = 0,
): Promise<CapturedIssueComment> {
  let match: CapturedIssueComment | undefined;
  await expect
    .poll(() => {
      match = issueApi.comments.slice(startIndex).find((comment) => {
        return comment.body.includes(text);
      });
      return match?.body ?? null;
    })
    .not.toBeNull();
  if (!match) {
    throw new Error(
      `Expected a captured GitHub issue comment containing ${text}`,
    );
  }
  return match;
}

async function waitForArrayLength<T>(
  items: readonly T[],
  length: number,
): Promise<void> {
  await expect
    .poll(() => {
      return items.length;
    })
    .toBe(length);
}

async function waitForRunnerJob(
  api: ReturnType<typeof createRunsAutomationsApi>,
  runnerGroup: string,
) {
  await api.heartbeatRunner(runnerGroup);
  let job:
    | Awaited<ReturnType<typeof api.pollRunner>>["body"]["job"]
    | undefined;
  await expect
    .poll(async () => {
      const poll = await api.pollRunner(runnerGroup);
      job = poll.body.job;
      return job?.runId ?? null;
    })
    .not.toBeNull();
  if (!job) {
    throw new Error("Expected a dispatched GitHub run to be pollable");
  }
  return job;
}

async function waitForRunStatus(
  api: ReturnType<typeof createRunsAutomationsApi>,
  actor: ApiTestUser,
  runId: string,
  status: "cancelled" | "completed" | "failed" | "pending" | "running",
): Promise<void> {
  await expect
    .poll(async () => {
      const run = await api.readRun(actor, runId);
      return run.status;
    })
    .toBe(status);
}

async function waitForAblyPublish(channel: string, payload: unknown) {
  await expect
    .poll(() => {
      return context.mocks.ably.publish.mock.calls.some((call) => {
        return call[0] === channel && call[1] === payload;
      });
    })
    .toBe(true);
}

function issueCommentEvent(args: {
  readonly remoteInstallationId: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly commentId: string;
  readonly commentBody: string;
  readonly sender: GithubWebhookSender;
}): string {
  const sender = webhookSender(args.sender);
  return JSON.stringify({
    action: "created",
    issue: {
      number: args.issueNumber,
      title: `BDD issue ${args.issueNumber}`,
      body: "Mention thread body.",
      labels: [],
      user: sender,
    },
    comment: {
      id: Number(args.commentId),
      body: args.commentBody,
      user: sender,
    },
    repository: { full_name: args.repo },
    installation: { id: Number(args.remoteInstallationId) },
    sender,
  });
}

async function postGithubWebhook(
  webhooks: ReturnType<typeof createWebhookCallbackApi>,
  body: string,
  event: "issues" | "issue_comment" | "pull_request" | "installation",
): Promise<void> {
  await webhooks.requestGithubWebhook(
    body,
    webhooks.signedGithubWebhookHeaders(body, event),
    [200],
  );
  // Webhook handling is detached and run dispatch nests more detached work.
}

function runIdFromAuditComment(body: string): string {
  const match = body.match(/\/activities\/([0-9a-f-]{36})/u);
  if (!match?.[1]) {
    throw new Error(`Expected an audit run link in comment: ${body}`);
  }
  return match[1];
}

async function claimNextGithubRun(
  api: ReturnType<typeof createRunsAutomationsApi>,
  runnerGroup: string,
): Promise<{
  readonly runId: string;
  readonly sandboxToken: string;
  readonly resumeSessionId: string | null;
}> {
  const job = await waitForRunnerJob(api, runnerGroup);
  const runId = job.runId;
  const claim = await api.claimRunnerJob(runId);
  return {
    runId,
    sandboxToken: claim.sandboxToken,
    resumeSessionId: claim.resumeSession?.sessionId ?? null,
  };
}

async function checkpointGithubRun(args: {
  readonly webhooks: ReturnType<typeof createWebhookCallbackApi>;
  readonly runId: string;
  readonly sandboxToken: string;
  readonly cliAgentSessionId: string;
}): Promise<void> {
  await args.webhooks.requestAgentCheckpoint(
    {
      runId: args.runId,
      cliAgentType: "claude-code",
      cliAgentSessionId: args.cliAgentSessionId,
      cliAgentSessionHistoryHash: createHash("sha256")
        .update(`bdd github session history ${args.runId}`)
        .digest("hex"),
    },
    { authorization: `Bearer ${args.sandboxToken}` },
    [200],
  );
}

async function completeGithubRun(args: {
  readonly api: ReturnType<typeof createRunsAutomationsApi>;
  readonly webhooks: ReturnType<typeof createWebhookCallbackApi>;
  readonly actor: ApiTestUser;
  readonly issueApi: CapturedIssueApi;
  readonly expectedCommentCount: number;
  readonly runId: string;
  readonly sandboxToken: string;
  readonly cliAgentSessionId: string;
  readonly result: string;
}): Promise<void> {
  await checkpointGithubRun({
    webhooks: args.webhooks,
    runId: args.runId,
    sandboxToken: args.sandboxToken,
    cliAgentSessionId: args.cliAgentSessionId,
  });
  context.mocks.axiom.query.mockResolvedValue([
    { eventType: "result", eventData: { result: args.result } },
  ]);
  await args.webhooks.requestAgentComplete(
    { runId: args.runId, exitCode: 0 },
    { authorization: `Bearer ${args.sandboxToken}` },
    [200],
  );
  const completed = await args.api.readRun(args.actor, args.runId);
  expect(completed.status).toBe("completed");
  await waitForCommentCount(args.issueApi, args.expectedCommentCount);
  context.mocks.axiom.query.mockResolvedValue([]);
}

describe("HOOK-01/INT-03 G6: issue-label runs and signed internal callbacks", () => {
  it("dispatches label-listener runs and replays signed callback deliveries", async () => {
    const senderGithubUserId = newGithubUserId();
    const harness = await githubRunActor(senderGithubUserId);
    const { api, webhooks, gh, actor, runnerGroup, issueApi } = harness;
    const repo = "bdd-org/bdd-repo";
    const sender = { githubUserId: senderGithubUserId };

    await gh.createLabelListener(
      actor,
      {
        labelName: "ready-for-zero",
        triggerMode: "anyone",
        prompt: "Handle the labeled issue",
        agentId: harness.secondAgentId,
      },
      [201],
    );

    await postGithubWebhook(
      webhooks,
      issuesLabeledEvent({
        remoteInstallationId: harness.remoteInstallationId,
        repo,
        issueNumber: 42,
        labelName: "ready-for-zero",
        sender,
      }),
      "issues",
    );
    await waitForCommentCount(issueApi, 1);
    const startedComment = issueApi.comments[0];
    if (!startedComment) {
      throw new Error("Expected a label-trigger started comment");
    }
    expect(startedComment.repo).toBe(repo);
    expect(startedComment.issueNumber).toBe("42");
    expect(startedComment.body).toContain(
      'received the "ready-for-zero" label',
    );
    const runId = runIdFromAuditComment(startedComment.body);
    const pending = await api.readRun(actor, runId);
    expect(pending.status).toBe("pending");

    // Progress callbacks deliver without posting comments or reading output.
    proxyGithubIssuesCallbackToApp(context);
    const job = await waitForRunnerJob(api, runnerGroup);
    expect(job.runId).toBe(runId);
    const claim = await api.claimRunnerJob(runId);
    const sandboxHeaders = { authorization: `Bearer ${claim.sandboxToken}` };
    const queriesBeforeProgress = context.mocks.axiom.query.mock.calls.length;
    await webhooks.requestAgentTelemetry(
      { runId, systemLog: "bdd github progress" },
      sandboxHeaders,
      [200],
    );
    await waitForCommentCount(issueApi, 1);
    expect(context.mocks.axiom.query.mock.calls).toHaveLength(
      queriesBeforeProgress,
    );

    // A sandbox heartbeat dispatches the pending callback as a signed
    // progress delivery; replaying it into the route returns the early
    // success without posting any comment.
    const deliveries = captureGithubIssuesCallbackDeliveries(context);
    await webhooks.requestAgentHeartbeat({ runId }, sandboxHeaders, [200]);
    await waitForArrayLength(deliveries, 1);
    const progressDelivery = deliveries[0];
    if (!progressDelivery?.signature || !progressDelivery.timestamp) {
      throw new Error("Expected a signed progress callback delivery");
    }
    expect(
      JSON.parse(progressDelivery.body) as Record<string, unknown>,
    ).toMatchObject({ runId, status: "progress" });
    const progressReplay = await gh.requestGithubIssuesCallback(
      progressDelivery.body,
      {
        "x-vm0-signature": progressDelivery.signature,
        "x-vm0-timestamp": progressDelivery.timestamp,
      },
      [200],
    );
    expect(progressReplay.body).toStrictEqual({ success: true });
    await waitForCommentCount(issueApi, 1);

    // Completion posts the audited comment through the captured delivery.
    await gh.enableAuditLink(actor);
    await checkpointGithubRun({
      webhooks,
      runId,
      sandboxToken: claim.sandboxToken,
      cliAgentSessionId: "bdd-cli-g6a-label",
    });
    context.mocks.axiom.query.mockResolvedValue([
      {
        eventType: "result",
        eventData: { result: "Implemented the requested issue fix." },
      },
    ]);
    await webhooks.requestAgentComplete(
      { runId, exitCode: 0 },
      sandboxHeaders,
      [200],
    );
    const completed = await api.readRun(actor, runId);
    expect(completed.status).toBe("completed");

    await waitForArrayLength(deliveries, 2);
    const delivery = deliveries[1];
    if (!delivery?.signature || !delivery.timestamp) {
      throw new Error("Expected a signed GitHub issues callback delivery");
    }
    await waitForCommentCount(issueApi, 2);
    context.mocks.axiom.query.mockResolvedValue([]);
    const completionComment = issueApi.comments[1];
    if (!completionComment) {
      throw new Error("Expected a completion comment");
    }
    expect(completionComment.body).toContain(
      "Implemented the requested issue fix.",
    );
    expect(completionComment.body).toContain("📋 [Audit]");
    expect(completionComment.body).toContain(`/activities/${runId}`);
    expect(completionComment.body).toContain("Responded by GitHub Agent");
    expect(completionComment.body).toContain("Claude");

    // Replay without GitHub App credentials: 500 after verification.
    const replayHeaders = {
      "x-vm0-signature": delivery.signature,
      "x-vm0-timestamp": delivery.timestamp,
    };
    mockOptionalEnv("GITHUB_APP_ID", undefined);
    mockOptionalEnv("GITHUB_APP_PRIVATE_KEY", undefined);
    const unconfigured = await gh.requestGithubIssuesCallback(
      delivery.body,
      replayHeaders,
      [500],
    );
    expect(unconfigured.body).toStrictEqual({
      error: "GitHub App not configured",
    });
    mockGithubAppEnv();

    // Forged signatures and expired timestamps are rejected.
    const forged = await gh.requestGithubIssuesCallback(
      delivery.body,
      {
        "x-vm0-signature": "deadbeef",
        "x-vm0-timestamp": String(Math.floor(now() / 1000)),
      },
      [401],
    );
    expect(forged.body).toStrictEqual({ error: "Invalid signature" });
    const expired = await gh.requestGithubIssuesCallback(
      delivery.body,
      {
        "x-vm0-signature": delivery.signature,
        "x-vm0-timestamp": String(Math.floor((now() - 10 * 60_000) / 1000)),
      },
      [401],
    );
    expect(expired.body).toStrictEqual({ error: "Timestamp expired" });

    // A chat run's delivery verifies per-callback but fails payload parsing.
    const chatDeliveries = captureChatCallbackDeliveries();
    const chat = createChatFilesBddApi(context);
    const sent = await chat.requestSendMessage(
      actor,
      {
        agentId: harness.defaultAgentId,
        prompt: "github bdd chat run",
        modelProvider: "anthropic-api-key",
      },
      [201],
    );
    if (sent.status !== 201 || sent.body.runId === null) {
      throw new Error("Expected the entitled chat send to create a run");
    }
    await api.requestCancelRun(actor, sent.body.runId, [200]);
    await waitForArrayLength(chatDeliveries, 1);
    const chatDelivery = chatDeliveries[0];
    if (!chatDelivery?.signature || !chatDelivery.timestamp) {
      throw new Error("Expected a signed chat callback delivery");
    }
    const mismatched = await gh.requestGithubIssuesCallback(
      chatDelivery.body,
      {
        "x-vm0-signature": chatDelivery.signature,
        "x-vm0-timestamp": chatDelivery.timestamp,
      },
      [400],
    );
    expect(mismatched.body).toStrictEqual({
      error: "Invalid or missing payload",
    });

    // Cancelling a second labeled run posts the formatted failure comment.
    await postGithubWebhook(
      webhooks,
      issuesLabeledEvent({
        remoteInstallationId: harness.remoteInstallationId,
        repo,
        issueNumber: 43,
        labelName: "ready-for-zero",
        sender,
      }),
      "issues",
    );
    await waitForCommentCount(issueApi, 3);
    const secondStarted = issueApi.comments[2];
    if (!secondStarted) {
      throw new Error("Expected a second label-trigger started comment");
    }
    const secondRunId = runIdFromAuditComment(secondStarted.body);
    const queriesBeforeFailure = context.mocks.axiom.query.mock.calls.length;
    await api.requestCancelRun(actor, secondRunId, [200]);
    const cancelledRun = await api.readRun(actor, secondRunId);
    expect(cancelledRun.status).toBe("cancelled");
    await waitForCommentCount(issueApi, 4);
    const failureComment = issueApi.comments[3];
    if (!failureComment) {
      throw new Error("Expected a failure comment");
    }
    expect(failureComment.body).toContain("Run cancelled");
    expect(context.mocks.axiom.query.mock.calls).toHaveLength(
      queriesBeforeFailure,
    );

    // Deleting the installation orphans further replays of the delivery.
    mockOptionalEnv("GITHUB_APP_ID", undefined);
    mockOptionalEnv("GITHUB_APP_PRIVATE_KEY", undefined);
    await gh.deleteInstallation(actor, [200]);
    const orphaned = await gh.requestGithubIssuesCallback(
      delivery.body,
      replayHeaders,
      [404],
    );
    expect(orphaned.body).toStrictEqual({
      error: "GitHub installation not found",
    });
  });

  it("maintains GitHub issue session continuity across mention and label runs", async () => {
    const senderGithubUserId = newGithubUserId();
    const harness = await githubRunActor(senderGithubUserId);
    const { api, webhooks, gh, actor, runnerGroup, issueApi } = harness;
    const repo = "bdd-org/bdd-sessions";
    const sender = { githubUserId: senderGithubUserId };
    proxyGithubIssuesCallbackToApp(context);

    function mention(commentId: string, commentBody: string): string {
      return issueCommentEvent({
        remoteInstallationId: harness.remoteInstallationId,
        repo,
        issueNumber: 7,
        commentId,
        commentBody,
        sender,
      });
    }

    // First mention creates a run, quotes the trigger, and drops the reaction.
    await postGithubWebhook(
      webhooks,
      mention("100", "@Zero please fix this\nwith context"),
      "issue_comment",
    );
    expect(issueApi.comments).toStrictEqual([]);
    const first = await claimNextGithubRun(api, runnerGroup);
    expect(first.resumeSessionId).toBeNull();
    await completeGithubRun({
      api,
      webhooks,
      actor,
      issueApi,
      expectedCommentCount: 1,
      runId: first.runId,
      sandboxToken: first.sandboxToken,
      cliAgentSessionId: "bdd-cli-g6b-first",
      result: "Handled the first mention.",
    });
    const firstComment = issueApi.comments[0];
    if (!firstComment) {
      throw new Error("Expected a completion comment for the first mention");
    }
    expect(firstComment.body).toContain("> @Zero please fix this");
    expect(firstComment.body).toContain("> with context");
    expect(firstComment.body).toContain("Handled the first mention.");
    // The audit feature switch is off for this actor and the run agent is
    // the installation default, so neither footer appears.
    expect(firstComment.body).not.toContain("Audit");
    expect(firstComment.body).not.toContain("Responded by");
    await waitForArrayLength(issueApi.reactionDeletes, 1);
    expect(issueApi.reactionDeletes[0]?.commentId).toBe("100");

    // The second mention resumes the saved issue session: its claimed job
    // carries the first run's CLI session for resumption.
    await postGithubWebhook(
      webhooks,
      mention("200", "@Zero continue please"),
      "issue_comment",
    );
    const second = await claimNextGithubRun(api, runnerGroup);
    expect(second.resumeSessionId).toBe("bdd-cli-g6b-first");
    await completeGithubRun({
      api,
      webhooks,
      actor,
      issueApi,
      expectedCommentCount: 2,
      runId: second.runId,
      sandboxToken: second.sandboxToken,
      cliAgentSessionId: "bdd-cli-g6b-first",
      result: "Continued in the same session.",
    });

    // A mention whose comment id matches the bot's last reply is a duplicate.
    await postGithubWebhook(
      webhooks,
      mention(issueApi.lastCommentId(), "@Zero again"),
      "issue_comment",
    );
    await api.heartbeatRunner(runnerGroup);
    const idlePoll = await api.pollRunner(runnerGroup);
    expect(idlePoll.body.job ?? null).toBeNull();

    // Switching the default agent invalidates the stored session, so the
    // next mention starts a fresh session under the new agent.
    const secondAgentName = await gh.readComposeName(
      actor,
      harness.secondAgentId,
    );
    await gh.updateInstallation(actor, secondAgentName, [200]);
    await postGithubWebhook(
      webhooks,
      mention("300", "@Zero start fresh"),
      "issue_comment",
    );
    const third = await claimNextGithubRun(api, runnerGroup);
    expect(third.resumeSessionId).toBeNull();
    await completeGithubRun({
      api,
      webhooks,
      actor,
      issueApi,
      expectedCommentCount: 3,
      runId: third.runId,
      sandboxToken: third.sandboxToken,
      cliAgentSessionId: "bdd-cli-g6b-third",
      result: "Started a fresh session.",
    });

    // Label runs disable continuity and never replace the saved session.
    await gh.createLabelListener(
      actor,
      {
        labelName: "continuity-check",
        triggerMode: "anyone",
        prompt: "Run without continuity",
        agentId: harness.secondAgentId,
      },
      [201],
    );
    await postGithubWebhook(
      webhooks,
      issuesLabeledEvent({
        remoteInstallationId: harness.remoteInstallationId,
        repo,
        issueNumber: 7,
        labelName: "continuity-check",
        sender,
      }),
      "issues",
    );
    const labelRun = await claimNextGithubRun(api, runnerGroup);
    expect(labelRun.resumeSessionId).toBeNull();
    await completeGithubRun({
      api,
      webhooks,
      actor,
      issueApi,
      expectedCommentCount: 4,
      runId: labelRun.runId,
      sandboxToken: labelRun.sandboxToken,
      cliAgentSessionId: "bdd-cli-g6b-label",
      result: "Label run output.",
    });

    // The next mention still resumes the third run's session.
    await postGithubWebhook(
      webhooks,
      mention("400", "@Zero one more time"),
      "issue_comment",
    );
    const fourth = await claimNextGithubRun(api, runnerGroup);
    expect(fourth.resumeSessionId).toBe("bdd-cli-g6b-third");

    await api.requestCancelRun(actor, fourth.runId, [200]);
    const fourthCancelled = await api.readRun(actor, fourth.runId);
    expect(fourthCancelled.status).toBe("cancelled");
  });

  it("rejects callbacks without a runId or callback record", async () => {
    const gh = createGithubBddApi(context);

    const missingRunId = await gh.requestGithubIssuesCallback(
      JSON.stringify({ status: "completed", payload: {} }),
      {},
      [400],
    );
    expect(missingRunId.body).toStrictEqual({ error: "Missing runId" });

    const unknownRun = await gh.requestGithubIssuesCallback(
      JSON.stringify({ runId: randomUUID(), status: "completed", payload: {} }),
      {},
      [404],
    );
    expect(unknownRun.body).toStrictEqual({ error: "Callback not found" });
  });
});

describe("HOOK-02/INT-03 G7: label dispatch context and trigger gating", () => {
  it("renders issue context and file blocks into label-dispatched runs", async () => {
    const senderGithubUserId = newGithubUserId();
    const harness = await githubRunActor(senderGithubUserId);
    const { api, webhooks, gh, actor, runnerGroup, issueApi } = harness;
    const repo = "bdd-org/bdd-label-dispatch";
    const sender = { githubUserId: senderGithubUserId };
    proxyGithubIssuesCallbackToApp(context);

    await gh.createLabelListener(
      actor,
      {
        labelName: "zero-dispatch",
        triggerMode: "anyone",
        prompt: "Handle the dispatched issue",
        agentId: harness.secondAgentId,
      },
      [201],
    );

    // An opened issue carrying the matching label dispatches with the issue
    // context and attachment file blocks rendered into the system prompt.
    const fileUrl = "https://github.com/user-attachments/assets/abc123";
    await postGithubWebhook(
      webhooks,
      issuesEvent({
        remoteInstallationId: harness.remoteInstallationId,
        repo,
        issueNumber: 41,
        action: "opened",
        labels: ["enhancement", "zero-dispatch"],
        issueBody: `Please inspect this attachment:\n\n![screenshot.png](${fileUrl})`,
        sender,
      }),
      "issues",
    );
    const startedComment = await waitForCommentContaining(
      issueApi,
      'received the "zero-dispatch" label',
    );
    expect(startedComment.body).toContain('received the "zero-dispatch" label');
    const firstRunId = runIdFromAuditComment(startedComment.body);

    const firstJob = await waitForRunnerJob(api, runnerGroup);
    expect(firstJob.runId).toBe(firstRunId);
    expect(firstJob.prompt).toBe("Handle the dispatched issue");
    const firstContext = firstJob.appendSystemPrompt ?? "";
    expect(firstContext).toContain("# GitHub Issue Context");
    expect(firstContext).toContain(
      `Issue URL: https://github.com/${repo}/issues/41`,
    );
    expect(firstContext).toContain("- MSG_ID: issue:41");
    expect(firstContext).toContain("Matched label: zero-dispatch");
    expect(firstContext).toContain("[GitHub file]");
    expect(firstContext).toContain(`[URL] ${fileUrl}`);
    expect(firstContext).toContain("[FILENAME] screenshot.png");
    expect(firstContext).not.toContain(`![screenshot.png](${fileUrl})`);
    expect(firstContext).toContain("You are currently running inside: GitHub");
    await api.claimRunnerJob(firstRunId);
    await api.requestCancelRun(actor, firstRunId, [200]);
    await waitForRunStatus(api, actor, firstRunId, "cancelled");

    // A null issue body falls back to the placeholder paragraph.
    const beforeSecondDispatch = issueApi.comments.length;
    await postGithubWebhook(
      webhooks,
      issuesEvent({
        remoteInstallationId: harness.remoteInstallationId,
        repo,
        issueNumber: 42,
        action: "opened",
        labels: ["zero-dispatch"],
        issueTitle: "Fallback title",
        issueBody: null,
        sender,
      }),
      "issues",
    );
    const secondStartedComment = await waitForCommentContaining(
      issueApi,
      'received the "zero-dispatch" label',
      beforeSecondDispatch,
    );
    const secondRunId = runIdFromAuditComment(secondStartedComment.body);
    const secondJob = await waitForRunnerJob(api, runnerGroup);
    expect(secondJob.runId).toBe(secondRunId);
    const secondContext = secondJob.appendSystemPrompt ?? "";
    expect(secondContext).toContain("Title: Fallback title");
    expect(secondContext).toContain("_No description provided._");
    await api.claimRunnerJob(secondRunId);
    await api.requestCancelRun(actor, secondRunId, [200]);
    await waitForRunStatus(api, actor, secondRunId, "cancelled");

    // Non-matching labels and ignored actions never dispatch.
    let commentCount = issueApi.comments.length;
    await postGithubWebhook(
      webhooks,
      issuesEvent({
        remoteInstallationId: harness.remoteInstallationId,
        repo,
        issueNumber: 43,
        action: "labeled",
        labels: ["zero-dispatch", "unrelated"],
        label: "unrelated",
        sender,
      }),
      "issues",
    );
    await postGithubWebhook(
      webhooks,
      issuesEvent({
        remoteInstallationId: harness.remoteInstallationId,
        repo,
        issueNumber: 43,
        action: "closed",
        labels: ["zero-dispatch"],
        sender,
      }),
      "issues",
    );
    await waitForCommentCount(issueApi, commentCount);
    const idlePoll = await api.pollRunner(runnerGroup);
    expect(idlePoll.body.job ?? null).toBeNull();

    // Labeled pull requests dispatch with pull-request context.
    const beforePrDispatch = issueApi.comments.length;
    await postGithubWebhook(
      webhooks,
      pullRequestEvent({
        remoteInstallationId: harness.remoteInstallationId,
        repo,
        issueNumber: 44,
        action: "labeled",
        labels: ["zero-dispatch"],
        label: "zero-dispatch",
        sender,
      }),
      "pull_request",
    );
    const prStartedComment = await waitForCommentContaining(
      issueApi,
      'received the "zero-dispatch" label',
      beforePrDispatch,
    );
    const prRunId = runIdFromAuditComment(prStartedComment.body);
    const prJob = await waitForRunnerJob(api, runnerGroup);
    expect(prJob.runId).toBe(prRunId);
    const prContext = prJob.appendSystemPrompt ?? "";
    expect(prContext).toContain("# GitHub Pull Request Context");
    expect(prContext).toContain(
      `Pull Request URL: https://github.com/${repo}/pull/44`,
    );
    await api.claimRunnerJob(prRunId);
    await api.requestCancelRun(actor, prRunId, [200]);
    await waitForRunStatus(api, actor, prRunId, "cancelled");

    // Creator-scoped listeners only fire for issues authored by the linked
    // creator account.
    await gh.createLabelListener(
      actor,
      {
        labelName: "mine-only",
        triggerMode: "created_by_me",
        prompt: "Handle my own issue",
        agentId: harness.secondAgentId,
      },
      [201],
    );
    const stranger = { githubUserId: newGithubUserId(), login: "stranger" };
    commentCount = issueApi.comments.length;
    const beforeCreatorDispatch = issueApi.comments.length;
    await postGithubWebhook(
      webhooks,
      issuesEvent({
        remoteInstallationId: harness.remoteInstallationId,
        repo,
        issueNumber: 45,
        action: "labeled",
        labels: ["mine-only"],
        label: "mine-only",
        issueUser: stranger,
        sender: stranger,
      }),
      "issues",
    );
    await waitForCommentCount(issueApi, commentCount);
    const strangerPoll = await api.pollRunner(runnerGroup);
    expect(strangerPoll.body.job ?? null).toBeNull();

    await postGithubWebhook(
      webhooks,
      issuesEvent({
        remoteInstallationId: harness.remoteInstallationId,
        repo,
        issueNumber: 46,
        action: "labeled",
        labels: ["mine-only"],
        label: "mine-only",
        issueUser: sender,
        sender,
      }),
      "issues",
    );
    const creatorStartedComment = await waitForCommentContaining(
      issueApi,
      'received the "mine-only" label',
      beforeCreatorDispatch,
    );
    const creatorRunId = runIdFromAuditComment(creatorStartedComment.body);
    const creatorJob = await waitForRunnerJob(api, runnerGroup);
    expect(creatorJob.runId).toBe(creatorRunId);
    expect(creatorJob.prompt).toBe("Handle my own issue");
    await api.claimRunnerJob(creatorRunId);
    await api.requestCancelRun(actor, creatorRunId, [200]);
    await waitForRunStatus(api, actor, creatorRunId, "cancelled");
  });

  it("reports rejected and failed label dispatches through comments and callbacks", async () => {
    const bdd = createBddApi(context);
    const api = createRunsAutomationsApi(context);
    const webhooks = createWebhookCallbackApi(context);
    const gh = createGithubBddApi(context);

    // An installed but never-entitled org turns the admission rejection into
    // a formatted failure comment without creating a run.
    const actor = bdd.user();
    acceptGithubRunObjectStorage(context);
    api.acceptStorageDownloads();
    api.acceptTelemetryIngest();
    await bdd.setupOnboarding(actor, {
      displayName: "BDD Unentitled GitHub Agent",
    });
    await api.ensureOrgModelProvider(actor);
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD Rejected Dispatch Agent",
      visibility: "private",
    });
    const senderGithubUserId = newGithubUserId();
    const install = await gh.installGithubApp(actor, agent.agentId, {
      oauthCode: {
        code: `g7b-${randomUUID().slice(0, 8)}`,
        githubUserId: senderGithubUserId,
      },
    });
    webhooks.configureGithubWebhookSecret();
    const issueApi = captureGithubIssueApi(install.remoteInstallationId);
    mockClerkMembership(context, actor, "org:admin");
    await gh.createLabelListener(
      actor,
      {
        labelName: "no-credits",
        triggerMode: "anyone",
        prompt: "Run without credits",
        agentId: agent.agentId,
      },
      [201],
    );

    await postGithubWebhook(
      webhooks,
      issuesEvent({
        remoteInstallationId: install.remoteInstallationId,
        repo: "bdd-org/bdd-rejected",
        issueNumber: 50,
        action: "labeled",
        labels: ["no-credits"],
        label: "no-credits",
        sender: { githubUserId: senderGithubUserId },
      }),
      "issues",
    );
    await waitForCommentCount(issueApi, 1);
    const rejection = latestComment(issueApi);
    expect(rejection.body).toContain("Insufficient credits");
    expect(rejection.body).toContain("Add credits:");
    const queue = await api.readRunQueue(actor);
    expect(queue.body.concurrency.active).toBe(0);

    // A listener targeting another member's private agent fails admission
    // with a non-credit error that still surfaces as a failure comment.
    const privateOwner = bdd.user({
      orgId: actor.orgId,
      orgRole: "org:member",
    });
    const privateAgent = await bdd.createAgent(privateOwner, {
      displayName: "BDD Foreign Private Agent",
      visibility: "private",
    });
    await gh.createLabelListener(
      actor,
      {
        labelName: "foreign-agent",
        triggerMode: "anyone",
        prompt: "Run a foreign private agent",
        agentId: privateAgent.agentId,
      },
      [201],
    );
    await postGithubWebhook(
      webhooks,
      issuesEvent({
        remoteInstallationId: install.remoteInstallationId,
        repo: "bdd-org/bdd-rejected",
        issueNumber: 52,
        action: "labeled",
        labels: ["foreign-agent"],
        label: "foreign-agent",
        sender: { githubUserId: senderGithubUserId },
      }),
      "issues",
    );
    await waitForCommentCount(issueApi, 2);
    expect(latestComment(issueApi).body).not.toContain("Add credits:");
    expect((await api.readRunQueue(actor)).body.concurrency.active).toBe(0);

    // An entitled org without a configured runner records the failed run and
    // reports it through the signed callback instead of a started comment.
    const entitled = bdd.user();
    await api.grantProEntitlement(entitled);
    await api.ensureOrgModelProvider(entitled);
    const entitledAgent = await bdd.createAgent(entitled, {
      displayName: "BDD Failed Dispatch Agent",
      visibility: "private",
    });
    const entitledSenderId = newGithubUserId();
    const entitledInstall = await gh.installGithubApp(
      entitled,
      entitledAgent.agentId,
      {
        oauthCode: {
          code: `g7b2-${randomUUID().slice(0, 8)}`,
          githubUserId: entitledSenderId,
        },
      },
    );
    webhooks.configureGithubWebhookSecret();
    const entitledIssueApi = captureGithubIssueApi(
      entitledInstall.remoteInstallationId,
    );
    const deliveries = captureGithubIssuesCallbackDeliveries(context);
    await gh.createLabelListener(
      entitled,
      {
        labelName: "no-runner",
        triggerMode: "anyone",
        prompt: "Run without a runner group",
        agentId: entitledAgent.agentId,
      },
      [201],
    );
    // Without GitHub App credentials the dispatch proceeds tokenless (no
    // reaction, no comment history, empty issue context); without a runner
    // group the created run fails immediately.
    mockOptionalEnv("GITHUB_APP_ID", undefined);
    mockOptionalEnv("GITHUB_APP_PRIVATE_KEY", undefined);
    mockOptionalEnv("RUNNER_DEFAULT_GROUP", undefined);

    await postGithubWebhook(
      webhooks,
      issuesEvent({
        remoteInstallationId: entitledInstall.remoteInstallationId,
        repo: "bdd-org/bdd-failed",
        issueNumber: 51,
        action: "labeled",
        labels: ["no-runner"],
        label: "no-runner",
        sender: { githubUserId: entitledSenderId },
      }),
      "issues",
    );

    await waitForArrayLength(deliveries, 1);
    const delivery = JSON.parse(deliveries[0]?.body ?? "{}") as Record<
      string,
      unknown
    >;
    expect(delivery).toMatchObject({
      status: "failed",
      error: "No executor configured: set RUNNER_DEFAULT_GROUP",
    });
    const failedRunId =
      typeof delivery.runId === "string" ? delivery.runId : "";
    const failedRun = await api.readRun(entitled, failedRunId);
    expect(failedRun.status).toBe("failed");
    expect(failedRun.error).toBe(
      "No executor configured: set RUNNER_DEFAULT_GROUP",
    );
    // Without GitHub App credentials neither a started-work comment nor a
    // callback-driven failure comment can be posted.
    await waitForCommentCount(entitledIssueApi, 0);
  });
});

describe("HOOK-02/INT-03 G8: bot mention dispatches", () => {
  it("dispatches alias mentions with file blocks and connect links for unlinked senders", async () => {
    const senderGithubUserId = newGithubUserId();
    const harness = await githubRunActor(senderGithubUserId);
    const { api, webhooks, actor, runnerGroup } = harness;
    const repo = "bdd-org/bdd-mentions";
    const sender = { githubUserId: senderGithubUserId };
    proxyGithubIssuesCallbackToApp(context);
    // Re-capture the issue API with earlier conversation history so the
    // dispatched context renders prior comments (and drops the trigger).
    const issueApi = captureGithubIssueApi(harness.remoteInstallationId, {
      commentHistory: [
        { id: 12, login: "maintainer", body: "Earlier discussion" },
        { id: 900, login: "octocat", body: "@Zero please inspect" },
      ],
    });

    // A linked user mentioning the @Zero alias dispatches a run whose prompt
    // replaces comment file HTML with URL file blocks.
    const fileUrl =
      "https://github.com/user-attachments/assets/4a354666-2014-433a-82c3-dc6941d6f0ec";
    await postGithubWebhook(
      webhooks,
      issueCommentEvent({
        remoteInstallationId: harness.remoteInstallationId,
        repo,
        issueNumber: 9,
        commentId: "900",
        commentBody: `@Zero please inspect\n\n<img width="480" height="480" alt="Image" src="${fileUrl}">`,
        sender,
      }),
      "issue_comment",
    );
    const mentionJob = await waitForRunnerJob(api, runnerGroup);
    expect(mentionJob.prompt).toContain("please inspect");
    expect(mentionJob.prompt).not.toContain("@Zero");
    expect(mentionJob.prompt).toContain("[GitHub file]");
    expect(mentionJob.prompt).toContain(`[URL] ${fileUrl}`);
    expect(mentionJob.prompt).not.toContain("<img");
    expect(mentionJob.prompt).not.toContain("[FILENAME]");
    expect(mentionJob.appendSystemPrompt).toContain(
      `Matched trigger: @${GITHUB_APP_SLUG}[bot] mention`,
    );
    expect(mentionJob.appendSystemPrompt).toContain("- MSG_ID: issue:9");
    // Prior comments render as context messages; the trigger comment is
    // filtered out of the history.
    expect(mentionJob.appendSystemPrompt).toContain("Earlier discussion");
    expect(mentionJob.appendSystemPrompt).toContain("- MSG_ID: comment:12");
    expect(mentionJob.appendSystemPrompt).not.toContain(
      "- MSG_ID: comment:900",
    );
    await api.requestCancelRun(actor, mentionJob.runId, [200]);
    await waitForRunStatus(api, actor, mentionJob.runId, "cancelled");
    await waitForCommentCount(issueApi, 1);

    // Mentions from unlinked senders receive a signed connect-link comment
    // instead of a run.
    const unlinked = {
      githubUserId: newGithubUserId(),
      login: "unlinked-user",
    };
    const beforeConnect = issueApi.comments.length;
    await postGithubWebhook(
      webhooks,
      issueCommentEvent({
        remoteInstallationId: harness.remoteInstallationId,
        repo,
        issueNumber: 9,
        commentId: "901",
        commentBody: "@Zero please help",
        sender: unlinked,
      }),
      "issue_comment",
    );
    await waitForCommentCount(issueApi, beforeConnect + 1);
    const connectComment = latestComment(issueApi).body;
    expect(connectComment).toContain("connect your GitHub account first");
    const connectUrlText = connectComment.match(
      /\[Connect GitHub\]\(([^)]+)\)/u,
    )?.[1];
    if (!connectUrlText) {
      throw new Error("Expected a connect link in the comment");
    }
    const connectUrl = new URL(connectUrlText);
    expect(connectUrl.origin).toBe(APP_ORIGIN);
    expect(connectUrl.pathname).toBe("/github/connect");
    expect(connectUrl.searchParams.get("installation")).toBe(
      harness.remoteInstallationId,
    );
    expect(connectUrl.searchParams.get("ghUser")).toBe(unlinked.githubUserId);
    expect(connectUrl.searchParams.get("ghLogin")).toBe("unlinked-user");
    expect(connectUrl.searchParams.get("ts")).toMatch(/^\d+$/u);
    expect(connectUrl.searchParams.get("sig")).toMatch(/^[0-9a-f]{64}$/u);
    const unlinkedPoll = await api.pollRunner(runnerGroup);
    expect(unlinkedPoll.body.job ?? null).toBeNull();

    // Label and mention events for unknown installations are acknowledged
    // without dispatching or commenting.
    const unknownInstallationId = newRemoteInstallationId();
    const beforeUnknown = issueApi.comments.length;
    await postGithubWebhook(
      webhooks,
      issuesEvent({
        remoteInstallationId: unknownInstallationId,
        repo,
        issueNumber: 10,
        action: "labeled",
        labels: ["zero-dispatch"],
        label: "zero-dispatch",
        sender,
      }),
      "issues",
    );
    await postGithubWebhook(
      webhooks,
      issueCommentEvent({
        remoteInstallationId: unknownInstallationId,
        repo,
        issueNumber: 10,
        commentId: "902",
        commentBody: "@Zero anyone home?",
        sender,
      }),
      "issue_comment",
    );
    await waitForCommentCount(issueApi, beforeUnknown);
    const unknownPoll = await api.pollRunner(runnerGroup);
    expect(unknownPoll.body.job ?? null).toBeNull();
  });
});

describe("HOOK-02/INT-03 G9: installation lifecycle webhooks", () => {
  it("removes installations and notifies linked users on installation deleted events", async () => {
    const bdd = createBddApi(context);
    const gh = createGithubBddApi(context);
    const webhooks = createWebhookCallbackApi(context);

    const actor = bdd.user();
    const agent = await bdd.createAgent(actor, {
      displayName: "BDD Install Cleanup Agent",
      visibility: "private",
    });
    const install = await gh.installGithubApp(actor, agent.agentId, {
      oauthCode: {
        code: `g9-${randomUUID().slice(0, 8)}`,
        githubUserId: newGithubUserId(),
      },
    });
    await gh.createLabelListener(
      actor,
      {
        labelName: "cleanup-probe",
        triggerMode: "anyone",
        prompt: "Probe the cleanup",
        agentId: agent.agentId,
      },
      [201],
    );
    webhooks.configureGithubWebhookSecret();

    context.mocks.ably.publish.mockClear();
    const body = installationEvent({
      action: "deleted",
      installationId: install.remoteInstallationId,
      targetId: install.targetId,
    });
    const response = await webhooks.requestGithubWebhook(
      body,
      webhooks.signedGithubWebhookHeaders(body, "installation"),
      [200],
    );
    expect(response.body).toBe("OK");

    await waitForAblyPublish("github:changed", null);
    const missing = await gh.requestReadInstallation(actor, [404]);
    expect(missing.body.error.code).toBe("NOT_FOUND");
  });
});
