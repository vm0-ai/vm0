import { Buffer } from "node:buffer";
import {
  createHmac,
  generateKeyPairSync,
  randomInt,
  randomUUID,
} from "node:crypto";

import { createStore } from "ccstate";
import { connectors } from "@vm0/db/schema/connector";
import { githubInstallations } from "@vm0/db/schema/github-installation";
import { githubUserLinks } from "@vm0/db/schema/github-user-link";
import { orgMembersCache } from "@vm0/db/schema/org-members-cache";
import { eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";

import { createApp } from "../../../app-factory";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import { decryptSecretValue } from "../../services/crypto.utils";
import {
  deleteUsageInsightFixture$,
  seedCompose$,
} from "./helpers/zero-usage-insight";

const context = testContext();
const store = createStore();
const APP_ID = "123456";
const APP_SLUG = "vm0-test";
const API_ORIGIN = "https://api.vm0.ai";
const WEB_ORIGIN = "https://www.vm0.ai";
const APP_ORIGIN = "https://app.vm0.ai";
const GITHUB_APP_SETUP_CALLBACK_PATH = "/api/github/app/setup/callback";
const GITHUB_APP_CLIENT_ID = "github-app-client-id";
const GITHUB_APP_CLIENT_SECRET = "github-app-client-secret";
const GH_OAUTH_CLIENT_ID = "github-oauth-client-id";
const GH_OAUTH_CLIENT_SECRET = "github-oauth-client-secret";
const TARGET_LOGIN = "test-org";
const TARGET_TYPE = "Organization";

interface ComposeFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly composeId: string;
}

interface CleanupState {
  installationIds: string[];
  installationRowIds: string[];
  targetIds: string[];
  userIds: string[];
  composeFixtures: ComposeFixture[];
}

function createCleanupState(): CleanupState {
  return {
    installationIds: [],
    installationRowIds: [],
    targetIds: [],
    userIds: [],
    composeFixtures: [],
  };
}

function newPrivateKeyBase64(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  return Buffer.from(pem).toString("base64");
}

function mockGithubAppEnv(
  args: {
    readonly slug?: boolean;
    readonly credentials?: boolean;
    readonly oauthCredentials?: boolean;
  } = {},
): void {
  if (args.slug !== false) {
    mockOptionalEnv("GITHUB_APP_SLUG", APP_SLUG);
  } else {
    mockOptionalEnv("GITHUB_APP_SLUG", undefined);
  }
  if (args.credentials !== false) {
    mockOptionalEnv("GITHUB_APP_ID", APP_ID);
    mockOptionalEnv("GITHUB_APP_PRIVATE_KEY", newPrivateKeyBase64());
  } else {
    mockOptionalEnv("GITHUB_APP_ID", undefined);
    mockOptionalEnv("GITHUB_APP_PRIVATE_KEY", undefined);
  }
  if (args.oauthCredentials !== false) {
    mockOptionalEnv("GITHUB_APP_CLIENT_ID", GITHUB_APP_CLIENT_ID);
    mockOptionalEnv("GITHUB_APP_CLIENT_SECRET", GITHUB_APP_CLIENT_SECRET);
  } else {
    mockOptionalEnv("GITHUB_APP_CLIENT_ID", undefined);
    mockOptionalEnv("GITHUB_APP_CLIENT_SECRET", undefined);
  }
}

function mockGithubUserOauthEnv(): void {
  mockOptionalEnv("GH_OAUTH_CLIENT_ID", GH_OAUTH_CLIENT_ID);
  mockOptionalEnv("GH_OAUTH_CLIENT_SECRET", GH_OAUTH_CLIENT_SECRET);
}

function mockSession(
  userId: string,
  orgId: string,
  orgRole: "org:admin" | "org:member" = "org:admin",
): void {
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: true,
    toAuth: () => {
      return { userId, orgId, orgRole };
    },
  });
}

function newGithubUserId(): string {
  return String(randomInt(1_000_000_000, 9_999_999_999));
}

async function appRequest(
  path: string,
  options: {
    readonly origin?: string;
    readonly headers?: HeadersInit;
  } = {},
): Promise<Response> {
  const app = createApp({ signal: context.signal });
  return await app.request(
    `${options.origin ?? "http://localhost:3000"}${path}`,
    {
      method: "GET",
      headers: options.headers,
    },
  );
}

async function seedComposeFixture(
  cleanup: CleanupState,
): Promise<ComposeFixture> {
  const orgId = `org_${randomUUID()}`;
  const userId = `user_${randomUUID()}`;
  const { composeId } = await store.set(
    seedCompose$,
    { orgId, userId },
    context.signal,
  );
  const fixture = { orgId, userId, composeId };
  cleanup.composeFixtures.push(fixture);
  cleanup.userIds.push(userId);
  return fixture;
}

function buildSignedState(args: {
  readonly userId: string;
  readonly composeId: string;
}): string {
  const payload = `${args.userId}:${args.composeId}`;
  const sig = createHmac("sha256", "a".repeat(64))
    .update(payload)
    .digest("hex");
  return JSON.stringify({
    vm0UserId: args.userId,
    composeId: args.composeId,
    sig,
  });
}

function buildSignedOrgState(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly composeId: string;
}): string {
  const payload = `${args.userId}:${args.orgId}:${args.composeId}`;
  const sig = createHmac("sha256", "a".repeat(64))
    .update(payload)
    .digest("hex");
  return JSON.stringify({
    vm0UserId: args.userId,
    orgId: args.orgId,
    composeId: args.composeId,
    sig,
  });
}

function buildUserConnectState(args: {
  readonly userId: string;
  readonly orgId: string;
}): string {
  const payload = `${args.userId}:${args.orgId}:`;
  const sig = createHmac("sha256", "a".repeat(64))
    .update(payload)
    .digest("hex");
  return JSON.stringify({
    vm0UserId: args.userId,
    orgId: args.orgId,
    sig,
  });
}

function mockGitHubInstallationsList(
  installations: readonly {
    readonly id: string;
    readonly targetId: string;
    readonly login?: string;
    readonly type?: string;
  }[],
): void {
  server.use(
    http.get("https://api.github.com/app/installations", () => {
      return HttpResponse.json(
        installations.map((installation) => {
          return {
            id: Number(installation.id),
            account: {
              id: Number(installation.targetId),
              login: installation.login ?? TARGET_LOGIN,
              type: installation.type ?? TARGET_TYPE,
            },
          };
        }),
      );
    }),
  );
}

function mockGitHubInstallation(args: {
  readonly installationId: string;
  readonly targetId: string;
  readonly login?: string;
  readonly type?: string;
  readonly token?: string;
}): void {
  server.use(
    http.get(
      "https://api.github.com/app/installations/:installationId",
      ({ params }) => {
        expect(String(params.installationId)).toBe(args.installationId);
        return HttpResponse.json({
          id: Number(args.installationId),
          account: {
            id: Number(args.targetId),
            login: args.login ?? TARGET_LOGIN,
            type: args.type ?? TARGET_TYPE,
          },
        });
      },
    ),
    http.post(
      "https://api.github.com/app/installations/:installationId/access_tokens",
      ({ params }) => {
        expect(String(params.installationId)).toBe(args.installationId);
        return HttpResponse.json({
          token: args.token ?? "ghs_test_installation_token",
          expires_at: "2099-01-01T00:00:00Z",
        });
      },
    ),
  );
}

async function seedGithubConnector(args: {
  readonly fixture: ComposeFixture;
  readonly githubUserId: string;
}): Promise<void> {
  await store.set(writeDb$).insert(connectors).values({
    type: "github",
    authMethod: "oauth",
    externalId: args.githubUserId,
    externalUsername: "octocat",
    userId: args.fixture.userId,
    orgId: args.fixture.orgId,
  });
}

async function seedOrgMembership(args: {
  readonly fixture: ComposeFixture;
  readonly role: "admin" | "member";
}): Promise<void> {
  await store.set(writeDb$).insert(orgMembersCache).values({
    orgId: args.fixture.orgId,
    userId: args.fixture.userId,
    role: args.role,
    cachedAt: nowDate(),
  });
}

function mockGithubUserOAuth(args: {
  readonly code: string;
  readonly accessToken?: string;
  readonly expectedClientId?: string;
  readonly expectedClientSecret?: string;
  readonly expectedRedirectUri?: string | null;
  readonly githubUserId: string;
  readonly login?: string;
}): void {
  server.use(
    http.post("https://github.com/login/oauth/access_token", async (info) => {
      const body = new URLSearchParams(await info.request.text());
      expect(body.get("client_id")).toBe(
        args.expectedClientId ?? GH_OAUTH_CLIENT_ID,
      );
      expect(body.get("client_secret")).toBe(
        args.expectedClientSecret ?? GH_OAUTH_CLIENT_SECRET,
      );
      expect(body.get("code")).toBe(args.code);
      if (args.expectedRedirectUri === null) {
        expect(body.has("redirect_uri")).toBeFalsy();
      } else {
        expect(body.get("redirect_uri")).toBe(
          args.expectedRedirectUri ??
            `${WEB_ORIGIN}/api/zero/github/oauth/connect/callback`,
        );
      }
      return HttpResponse.json({
        access_token: args.accessToken ?? "gho_user_oauth_token",
        scope: "repo,project,workflow",
      });
    }),
    http.get("https://api.github.com/user", ({ request }) => {
      expect(request.headers.get("authorization")).toBe(
        `Bearer ${args.accessToken ?? "gho_user_oauth_token"}`,
      );
      return HttpResponse.json({
        id: Number(args.githubUserId),
        login: args.login ?? "octocat",
        email: null,
      });
    }),
  );
}

async function findInstallationByRemoteId(installationId: string) {
  return await store
    .set(writeDb$)
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.installationId, installationId));
}

async function findInstallationByTargetId(targetId: string) {
  return await store
    .set(writeDb$)
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.targetId, targetId));
}

async function findLinksForUser(userId: string) {
  return await store
    .set(writeDb$)
    .select()
    .from(githubUserLinks)
    .where(eq(githubUserLinks.vm0UserId, userId));
}

describe("GitHub OAuth API routes", () => {
  const cleanup = createCleanupState();

  beforeEach(() => {
    mockEnv("SECRETS_ENCRYPTION_KEY", "a".repeat(64));
    mockEnv("VM0_WEB_URL", WEB_ORIGIN);
    mockEnv("APP_URL", APP_ORIGIN);
    mockGithubAppEnv();
    mockGithubUserOauthEnv();
  });

  afterEach(async () => {
    const db = store.set(writeDb$);
    if (cleanup.installationIds.length > 0) {
      await db
        .delete(githubInstallations)
        .where(
          inArray(githubInstallations.installationId, cleanup.installationIds),
        );
    }
    if (cleanup.installationRowIds.length > 0) {
      await db
        .delete(githubInstallations)
        .where(inArray(githubInstallations.id, cleanup.installationRowIds));
    }
    if (cleanup.targetIds.length > 0) {
      await db
        .delete(githubInstallations)
        .where(inArray(githubInstallations.targetId, cleanup.targetIds));
    }
    if (cleanup.userIds.length > 0) {
      await db
        .delete(githubUserLinks)
        .where(inArray(githubUserLinks.vm0UserId, cleanup.userIds));
      await db
        .delete(connectors)
        .where(inArray(connectors.userId, cleanup.userIds));
    }
    while (cleanup.composeFixtures.length > 0) {
      const fixture = cleanup.composeFixtures.pop();
      if (fixture) {
        await db
          .delete(orgMembersCache)
          .where(eq(orgMembersCache.orgId, fixture.orgId));
        await store.set(
          deleteUsageInsightFixture$,
          { orgId: fixture.orgId, userId: fixture.userId },
          context.signal,
        );
      }
    }
    cleanup.installationIds = [];
    cleanup.installationRowIds = [];
    cleanup.targetIds = [];
    cleanup.userIds = [];
  });

  it("redirects install requests to GitHub with signed state and API callback URI", async () => {
    mockGithubAppEnv({ credentials: false });

    const response = await appRequest(
      "/api/github/oauth/install?vm0UserId=user-1&composeId=compose-1",
    );

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin).toBe("https://github.com");
    expect(location.pathname).toBe(`/apps/${APP_SLUG}/installations/new`);
    expect(location.searchParams.get("redirect_uri")).toBe(
      `${WEB_ORIGIN}${GITHUB_APP_SETUP_CALLBACK_PATH}`,
    );
    const state = JSON.parse(location.searchParams.get("state")!) as {
      readonly vm0UserId: string;
      readonly composeId: string;
      readonly sig: string;
    };
    expect(state.vm0UserId).toBe("user-1");
    expect(state.composeId).toBe("compose-1");
    expect(state.sig).toBe(
      createHmac("sha256", "a".repeat(64))
        .update("user-1::compose-1")
        .digest("hex"),
    );
  });

  it("uses the trusted web origin for GitHub callback redirect_uri", async () => {
    mockGithubAppEnv({ credentials: false });

    const response = await appRequest(
      "/api/github/oauth/install?vm0UserId=user-1&composeId=compose-1",
      {
        origin: API_ORIGIN,
        headers: {
          "x-vm0-web-origin": WEB_ORIGIN,
        },
      },
    );

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.searchParams.get("redirect_uri")).toBe(
      `${WEB_ORIGIN}${GITHUB_APP_SETUP_CALLBACK_PATH}`,
    );
  });

  it("ignores untrusted web origins for GitHub callback redirect_uri", async () => {
    mockGithubAppEnv({ credentials: false });

    const response = await appRequest("/api/github/oauth/install", {
      headers: {
        "x-vm0-web-origin": "https://evil.example",
      },
    });

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.searchParams.get("redirect_uri")).toBe(
      `${WEB_ORIGIN}${GITHUB_APP_SETUP_CALLBACK_PATH}`,
    );
  });

  it("redirects direct API host install requests to the canonical web route", async () => {
    mockGithubAppEnv({ credentials: false });

    const path =
      "/api/github/oauth/install?vm0UserId=user-1&composeId=compose-1";
    const response = await appRequest(path, { origin: API_ORIGIN });

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`${WEB_ORIGIN}${path}`);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("redirects install requests to GitHub without state when no query is provided", async () => {
    const response = await appRequest("/api/github/oauth/install");

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin).toBe("https://github.com");
    expect(location.searchParams.has("state")).toBeFalsy();
    expect(location.searchParams.get("redirect_uri")).toBe(
      `${WEB_ORIGIN}${GITHUB_APP_SETUP_CALLBACK_PATH}`,
    );
  });

  it("starts GitHub user OAuth for integration account linking", async () => {
    mockSession("user-1", "org-1");

    const response = await appRequest("/api/zero/github/oauth/connect", {
      headers: { authorization: "Bearer clerk-session" },
    });

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin).toBe(WEB_ORIGIN);
    expect(location.pathname).toBe("/api/zero/connectors/github/authorize");
  });

  it("links a GitHub integration user from OAuth and connects the GitHub connector", async () => {
    const fixture = await seedComposeFixture(cleanup);
    const githubUserId = newGithubUserId();
    const [installation] = await store
      .set(writeDb$)
      .insert(githubInstallations)
      .values({
        installationId: "987650001",
        status: "active",
        orgId: fixture.orgId,
        defaultComposeId: fixture.composeId,
      })
      .returning({ id: githubInstallations.id });
    expect(installation).toBeDefined();
    cleanup.installationRowIds.push(installation!.id);
    const state = buildUserConnectState({
      userId: fixture.userId,
      orgId: fixture.orgId,
    });
    mockGithubUserOAuth({ code: "oauth-code-1", githubUserId });

    const response = await appRequest(
      `/api/zero/github/oauth/connect/callback?code=oauth-code-1&state=${encodeURIComponent(state)}`,
    );

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin).toBe(APP_ORIGIN);
    expect(location.pathname).toBe("/works");
    expect(location.searchParams.get("github")).toBe("connected");
    const links = await findLinksForUser(fixture.userId);
    expect(links).toHaveLength(1);
    expect(links[0]!.githubUserId).toBe(githubUserId);
    const connectorRows = await store
      .set(writeDb$)
      .select()
      .from(connectors)
      .where(eq(connectors.userId, fixture.userId));
    expect(connectorRows).toHaveLength(1);
    expect(connectorRows[0]).toMatchObject({
      type: "github",
      authMethod: "oauth",
      externalId: githubUserId,
      externalUsername: "octocat",
      oauthScopes: JSON.stringify(["repo", "project", "workflow"]),
    });
  });

  it("updates an existing GitHub connector after integration OAuth reconnect", async () => {
    const fixture = await seedComposeFixture(cleanup);
    const oldGithubUserId = newGithubUserId();
    const nextGithubUserId = newGithubUserId();
    await seedGithubConnector({ fixture, githubUserId: oldGithubUserId });
    const [installation] = await store
      .set(writeDb$)
      .insert(githubInstallations)
      .values({
        installationId: "987650002",
        status: "active",
        orgId: fixture.orgId,
        defaultComposeId: fixture.composeId,
      })
      .returning({ id: githubInstallations.id });
    expect(installation).toBeDefined();
    cleanup.installationRowIds.push(installation!.id);
    const state = buildUserConnectState({
      userId: fixture.userId,
      orgId: fixture.orgId,
    });
    mockGithubUserOAuth({
      code: "oauth-code-2",
      githubUserId: nextGithubUserId,
    });

    const response = await appRequest(
      `/api/zero/github/oauth/connect/callback?code=oauth-code-2&state=${encodeURIComponent(state)}`,
    );

    expect(response.status).toBe(307);
    const connectorRows = await store
      .set(writeDb$)
      .select()
      .from(connectors)
      .where(eq(connectors.userId, fixture.userId));
    expect(connectorRows).toHaveLength(1);
    expect(connectorRows[0]).toMatchObject({
      type: "github",
      authMethod: "oauth",
      externalId: nextGithubUserId,
      externalUsername: "octocat",
      oauthScopes: JSON.stringify(["repo", "project", "workflow"]),
    });
    const links = await findLinksForUser(fixture.userId);
    expect(links).toHaveLength(1);
    expect(links[0]!.githubUserId).toBe(nextGithubUserId);
  });

  it("returns 503 when GitHub App slug is not configured", async () => {
    mockOptionalEnv("GITHUB_APP_SLUG", undefined);

    const response = await appRequest("/api/github/oauth/install");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toStrictEqual({
      error: "GitHub App integration is not configured",
    });
  });

  it("links a local active installation during install", async () => {
    const fixture = await seedComposeFixture(cleanup);
    await seedOrgMembership({ fixture, role: "admin" });
    const githubUserId = newGithubUserId();
    await seedGithubConnector({ fixture, githubUserId });
    const [installation] = await store
      .set(writeDb$)
      .insert(githubInstallations)
      .values({
        installationId: "987654321",
        status: "active",
        orgId: fixture.orgId,
        adminGithubUserId: null,
        defaultComposeId: fixture.composeId,
      })
      .returning({ id: githubInstallations.id });
    expect(installation).toBeDefined();
    cleanup.installationRowIds.push(installation!.id);

    const response = await appRequest(
      `/api/github/oauth/install?vm0UserId=${fixture.userId}&orgId=${fixture.orgId}&composeId=${fixture.composeId}`,
    );

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin).toBe(APP_ORIGIN);
    expect(location.pathname).toBe("/works");
    expect(location.searchParams.get("github")).toBe("connected");
    const links = await findLinksForUser(fixture.userId);
    expect(links).toHaveLength(1);
    expect(links[0]!.githubUserId).toBe(githubUserId);
    const [linkedInstallation] = await store
      .set(writeDb$)
      .select({ status: githubInstallations.status })
      .from(githubInstallations)
      .where(eq(githubInstallations.id, links[0]!.installationId));
    expect(linkedInstallation?.status).toBe("active");
  });

  it("does not link an installation that belongs to another organization", async () => {
    const fixture = await seedComposeFixture(cleanup);
    const otherFixture = await seedComposeFixture(cleanup);
    await seedOrgMembership({ fixture, role: "admin" });
    const installationId = "987654322";
    const githubUserId = newGithubUserId();
    await seedGithubConnector({ fixture, githubUserId });
    await store.set(writeDb$).insert(githubInstallations).values({
      installationId,
      status: "active",
      orgId: otherFixture.orgId,
      adminGithubUserId: null,
      defaultComposeId: otherFixture.composeId,
    });
    cleanup.installationIds.push(installationId);
    mockGitHubInstallationsList([
      {
        id: installationId,
        targetId: newGithubUserId(),
      },
    ]);

    const response = await appRequest(
      `/api/github/oauth/install?vm0UserId=${fixture.userId}&orgId=${fixture.orgId}&composeId=${fixture.composeId}`,
    );

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin).toBe("https://github.com");
    expect(location.pathname).toBe(`/apps/${APP_SLUG}/installations/new`);
    await expect(findLinksForUser(fixture.userId)).resolves.toHaveLength(0);
  });

  it("creates and links a missing local installation during install from GitHub API data", async () => {
    const fixture = await seedComposeFixture(cleanup);
    await seedOrgMembership({ fixture, role: "admin" });
    const installationId = "123450001";
    const targetId = newGithubUserId();
    cleanup.installationIds.push(installationId);
    mockGitHubInstallationsList([
      { id: installationId, targetId, type: "User" },
    ]);
    mockGitHubInstallation({
      installationId,
      targetId,
      type: "User",
      token: "ghs_remote_installation_token",
    });

    const response = await appRequest(
      `/api/github/oauth/install?vm0UserId=${fixture.userId}&orgId=${fixture.orgId}&composeId=${fixture.composeId}`,
    );

    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/works");
    const installations = await findInstallationByRemoteId(installationId);
    expect(installations).toHaveLength(1);
    expect(installations[0]!.defaultComposeId).toBe(fixture.composeId);
    expect(installations[0]!.targetId).toBe(targetId);
    expect(installations[0]!.adminGithubUserId).toBe(targetId);
    expect(decryptSecretValue(installations[0]!.encryptedAccessToken!)).toBe(
      "ghs_remote_installation_token",
    );
    const links = await findLinksForUser(fixture.userId);
    expect(links).toHaveLength(1);
  });

  it("rejects GitHub app install for org members", async () => {
    const fixture = await seedComposeFixture(cleanup);
    await seedOrgMembership({ fixture, role: "member" });

    const response = await appRequest(
      `/api/github/oauth/install?vm0UserId=${fixture.userId}&orgId=${fixture.orgId}&composeId=${fixture.composeId}`,
    );

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin).toBe(APP_ORIGIN);
    expect(location.pathname).toBe("/works");
    expect(location.searchParams.get("error")).toBe(
      "Only organization admins can install GitHub",
    );
  });

  it("redirects callback with an error when app credentials are missing", async () => {
    mockOptionalEnv("GITHUB_APP_ID", undefined);
    mockOptionalEnv("GITHUB_APP_PRIVATE_KEY", undefined);

    const response = await appRequest(GITHUB_APP_SETUP_CALLBACK_PATH);

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toContain("/works?error=");
    expect(location).toContain(
      "GitHub%20App%20integration%20is%20not%20configured",
    );
  });

  it("redirects callback update actions without an error", async () => {
    const response = await appRequest(
      `${GITHUB_APP_SETUP_CALLBACK_PATH}?installation_id=12345&setup_action=update`,
    );

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin).toBe(APP_ORIGIN);
    expect(location.pathname).toBe("/works");
    expect(location.searchParams.get("github")).toBe("installed");
    expect(location.searchParams.has("error")).toBeFalsy();
  });

  it("redirects direct API host callback requests to the canonical web route", async () => {
    const path = `${GITHUB_APP_SETUP_CALLBACK_PATH}?installation_id=12345&setup_action=update`;
    const response = await appRequest(path, { origin: API_ORIGIN });

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(`${WEB_ORIGIN}${path}`);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("redirects callback with an error for invalid JSON state", async () => {
    const response = await appRequest(
      `${GITHUB_APP_SETUP_CALLBACK_PATH}?installation_id=12345&setup_action=install&state=not-json`,
    );

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toContain("/works?error=");
    expect(location).toContain("Invalid%20OAuth%20state");
  });

  it("redirects callback with an error for invalid state signature", async () => {
    const state = JSON.stringify({
      vm0UserId: "user-123",
      composeId: "compose-123",
      sig: "invalid-signature",
    });

    const response = await appRequest(
      `${GITHUB_APP_SETUP_CALLBACK_PATH}?installation_id=12345&setup_action=install&state=${encodeURIComponent(state)}`,
    );

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toContain("/works?error=");
    expect(location).toContain("Invalid%20state%20signature");
  });

  it("redirects callback with an error when no default compose is configured", async () => {
    const response = await appRequest(
      `${GITHUB_APP_SETUP_CALLBACK_PATH}?installation_id=12345&setup_action=install`,
    );

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toContain("/works?error=");
    expect(location).toContain("Missing%20default%20agent");
  });

  it("creates a pending installation for request actions", async () => {
    const fixture = await seedComposeFixture(cleanup);
    const targetId = "777888999";
    cleanup.targetIds.push(targetId);
    const state = buildSignedState({
      userId: fixture.userId,
      composeId: fixture.composeId,
    });

    const response = await appRequest(
      `${GITHUB_APP_SETUP_CALLBACK_PATH}?setup_action=request&target_id=${targetId}&target_type=Organization&state=${encodeURIComponent(state)}`,
    );

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin).toBe(APP_ORIGIN);
    expect(location.pathname).toBe("/works");
    expect(location.searchParams.get("github")).toBe("pending");
    const installations = await findInstallationByTargetId(targetId);
    expect(installations).toHaveLength(1);
    expect(installations[0]).toMatchObject({
      installationId: null,
      encryptedAccessToken: null,
      status: "pending",
      targetId,
      targetType: "Organization",
      orgId: fixture.orgId,
      defaultComposeId: fixture.composeId,
    });
  });

  it("redirects callback with an error when installation id is missing", async () => {
    const fixture = await seedComposeFixture(cleanup);
    const state = buildSignedState({
      userId: fixture.userId,
      composeId: fixture.composeId,
    });

    const response = await appRequest(
      `${GITHUB_APP_SETUP_CALLBACK_PATH}?setup_action=install&state=${encodeURIComponent(state)}`,
    );

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toContain("/works?error=");
    expect(location).toContain("Missing%20installation%20ID");
  });

  it("creates an active installation and link on valid callback", async () => {
    const fixture = await seedComposeFixture(cleanup);
    const installationId = "223344556";
    const targetId = "112233445";
    cleanup.installationIds.push(installationId);
    await seedGithubConnector({ fixture, githubUserId: targetId });
    mockGitHubInstallation({
      installationId,
      targetId,
      token: "ghs_callback_installation_token",
    });
    const state = buildSignedState({
      userId: fixture.userId,
      composeId: fixture.composeId,
    });

    const response = await appRequest(
      `${GITHUB_APP_SETUP_CALLBACK_PATH}?installation_id=${installationId}&setup_action=install&state=${encodeURIComponent(state)}`,
    );

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin).toBe(APP_ORIGIN);
    expect(location.pathname).toBe("/works");
    expect(location.searchParams.has("error")).toBeFalsy();
    const installations = await findInstallationByRemoteId(installationId);
    expect(installations).toHaveLength(1);
    expect(installations[0]).toMatchObject({
      installationId,
      status: "active",
      targetType: TARGET_TYPE,
      targetId,
      targetName: TARGET_LOGIN,
      orgId: fixture.orgId,
      defaultComposeId: fixture.composeId,
    });
    expect(decryptSecretValue(installations[0]!.encryptedAccessToken!)).toBe(
      "ghs_callback_installation_token",
    );
    const links = await findLinksForUser(fixture.userId);
    expect(links).toHaveLength(1);
    expect(links[0]!.githubUserId).toBe(targetId);
  });

  it("connects the installing user when setup callback includes an OAuth code", async () => {
    const fixture = await seedComposeFixture(cleanup);
    await seedOrgMembership({ fixture, role: "admin" });
    const installationId = "223344557";
    const targetId = "112233446";
    const githubUserId = newGithubUserId();
    cleanup.installationIds.push(installationId);
    mockGitHubInstallation({
      installationId,
      targetId,
      token: "ghs_setup_code_installation_token",
    });
    mockGithubUserOAuth({
      code: "setup-oauth-code-1",
      githubUserId,
      expectedClientId: GITHUB_APP_CLIENT_ID,
      expectedClientSecret: GITHUB_APP_CLIENT_SECRET,
      expectedRedirectUri: null,
    });
    const state = buildSignedOrgState({
      userId: fixture.userId,
      orgId: fixture.orgId,
      composeId: fixture.composeId,
    });

    const response = await appRequest(
      `${GITHUB_APP_SETUP_CALLBACK_PATH}?installation_id=${installationId}&setup_action=install&code=setup-oauth-code-1&state=${encodeURIComponent(state)}`,
    );

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin).toBe(APP_ORIGIN);
    expect(location.pathname).toBe("/works");
    expect(location.searchParams.get("github")).toBe("connected");
    const installations = await findInstallationByRemoteId(installationId);
    expect(installations).toHaveLength(1);
    expect(decryptSecretValue(installations[0]!.encryptedAccessToken!)).toBe(
      "ghs_setup_code_installation_token",
    );
    const links = await findLinksForUser(fixture.userId);
    expect(links).toHaveLength(1);
    expect(links[0]!.githubUserId).toBe(githubUserId);
    const connectorRows = await store
      .set(writeDb$)
      .select()
      .from(connectors)
      .where(eq(connectors.userId, fixture.userId));
    expect(connectorRows).toHaveLength(1);
    expect(connectorRows[0]).toMatchObject({
      type: "github",
      authMethod: "oauth",
      externalId: githubUserId,
      externalUsername: "octocat",
      oauthScopes: JSON.stringify(["repo", "project", "workflow"]),
    });
  });

  it("reuses an existing installation during callback", async () => {
    const fixture = await seedComposeFixture(cleanup);
    const installationId = "667788990";
    const [installation] = await store
      .set(writeDb$)
      .insert(githubInstallations)
      .values({
        installationId,
        status: "active",
        orgId: fixture.orgId,
        targetType: TARGET_TYPE,
        targetId: "101010101",
        defaultComposeId: fixture.composeId,
      })
      .returning({ id: githubInstallations.id });
    expect(installation).toBeDefined();
    cleanup.installationRowIds.push(installation!.id);
    await seedGithubConnector({ fixture, githubUserId: "101010101" });
    const state = buildSignedState({
      userId: fixture.userId,
      composeId: fixture.composeId,
    });

    const response = await appRequest(
      `${GITHUB_APP_SETUP_CALLBACK_PATH}?installation_id=${installationId}&setup_action=install&state=${encodeURIComponent(state)}`,
    );

    expect(response.status).toBe(307);
    const installations = await findInstallationByRemoteId(installationId);
    expect(installations).toHaveLength(1);
    const links = await findLinksForUser(fixture.userId);
    expect(links).toHaveLength(1);
  });

  it("returns 500 when the GitHub installation info request fails", async () => {
    const fixture = await seedComposeFixture(cleanup);
    const installationId = "887766554";
    const state = buildSignedState({
      userId: fixture.userId,
      composeId: fixture.composeId,
    });
    server.use(
      http.get(
        "https://api.github.com/app/installations/:installationId",
        () => {
          return HttpResponse.json(
            { message: "Bad credentials" },
            { status: 401 },
          );
        },
      ),
    );

    const response = await appRequest(
      `${GITHUB_APP_SETUP_CALLBACK_PATH}?installation_id=${installationId}&setup_action=install&state=${encodeURIComponent(state)}`,
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Internal server error",
    });
  });
});
