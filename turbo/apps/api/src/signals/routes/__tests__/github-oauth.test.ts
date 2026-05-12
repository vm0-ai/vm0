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
import { eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";

import { createApp } from "../../../app-factory";
import { mockEnv, mockOptionalEnv } from "../../../lib/env";
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
}

function newGithubUserId(): string {
  return String(randomInt(1_000_000_000, 9_999_999_999));
}

async function appRequest(path: string): Promise<Response> {
  const app = createApp({ signal: context.signal });
  return await app.request(`http://api.test${path}`, { method: "GET" });
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
    mockGithubAppEnv();
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
      "http://localhost:3000/api/github/oauth/callback",
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
        .update("user-1:compose-1")
        .digest("hex"),
    );
  });

  it("redirects install requests to GitHub without state when no query is provided", async () => {
    const response = await appRequest("/api/github/oauth/install");

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.origin).toBe("https://github.com");
    expect(location.searchParams.has("state")).toBeFalsy();
    expect(location.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/api/github/oauth/callback",
    );
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
    const githubUserId = newGithubUserId();
    await seedGithubConnector({ fixture, githubUserId });
    const [installation] = await store
      .set(writeDb$)
      .insert(githubInstallations)
      .values({
        installationId: "987654321",
        status: "active",
        adminGithubUserId: null,
        defaultComposeId: fixture.composeId,
      })
      .returning({ id: githubInstallations.id });
    expect(installation).toBeDefined();
    cleanup.installationRowIds.push(installation!.id);

    const response = await appRequest(
      `/api/github/oauth/install?vm0UserId=${fixture.userId}&composeId=${fixture.composeId}`,
    );

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/settings");
    expect(location.searchParams.get("tab")).toBe("integrations");
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

  it("creates and links a missing local installation during install from GitHub API data", async () => {
    const fixture = await seedComposeFixture(cleanup);
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
      `/api/github/oauth/install?vm0UserId=${fixture.userId}&composeId=${fixture.composeId}`,
    );

    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).pathname).toBe(
      "/settings",
    );
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

  it("redirects callback with an error when app credentials are missing", async () => {
    mockOptionalEnv("GITHUB_APP_ID", undefined);
    mockOptionalEnv("GITHUB_APP_PRIVATE_KEY", undefined);

    const response = await appRequest("/api/github/oauth/callback");

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toContain("/works?error=");
    expect(location).toContain(
      "GitHub%20App%20integration%20is%20not%20configured",
    );
  });

  it("redirects callback update actions without an error", async () => {
    const response = await appRequest(
      "/api/github/oauth/callback?installation_id=12345&setup_action=update",
    );

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toContain("/works");
    expect(location).not.toContain("error=");
  });

  it("redirects callback with an error for invalid JSON state", async () => {
    const response = await appRequest(
      "/api/github/oauth/callback?installation_id=12345&setup_action=install&state=not-json",
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
      `/api/github/oauth/callback?installation_id=12345&setup_action=install&state=${encodeURIComponent(state)}`,
    );

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toContain("/works?error=");
    expect(location).toContain("Invalid%20state%20signature");
  });

  it("redirects callback with an error when no default compose is configured", async () => {
    mockEnv("VM0_DEFAULT_AGENT", "");

    const response = await appRequest(
      "/api/github/oauth/callback?installation_id=12345&setup_action=install",
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
      `/api/github/oauth/callback?setup_action=request&target_id=${targetId}&target_type=Organization&state=${encodeURIComponent(state)}`,
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/works?pending=true");
    const installations = await findInstallationByTargetId(targetId);
    expect(installations).toHaveLength(1);
    expect(installations[0]).toMatchObject({
      installationId: null,
      encryptedAccessToken: null,
      status: "pending",
      targetId,
      targetType: "Organization",
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
      `/api/github/oauth/callback?setup_action=install&state=${encodeURIComponent(state)}`,
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
      `/api/github/oauth/callback?installation_id=${installationId}&setup_action=install&state=${encodeURIComponent(state)}`,
    );

    expect(response.status).toBe(307);
    const location = response.headers.get("location");
    expect(location).toContain("/works");
    expect(location).not.toContain("error=");
    const installations = await findInstallationByRemoteId(installationId);
    expect(installations).toHaveLength(1);
    expect(installations[0]).toMatchObject({
      installationId,
      status: "active",
      targetType: TARGET_TYPE,
      targetId,
      targetName: TARGET_LOGIN,
      defaultComposeId: fixture.composeId,
    });
    expect(decryptSecretValue(installations[0]!.encryptedAccessToken!)).toBe(
      "ghs_callback_installation_token",
    );
    const links = await findLinksForUser(fixture.userId);
    expect(links).toHaveLength(1);
    expect(links[0]!.githubUserId).toBe(targetId);
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
      `/api/github/oauth/callback?installation_id=${installationId}&setup_action=install&state=${encodeURIComponent(state)}`,
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
      `/api/github/oauth/callback?installation_id=${installationId}&setup_action=install&state=${encodeURIComponent(state)}`,
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toStrictEqual({
      error: "Internal server error",
    });
  });
});
