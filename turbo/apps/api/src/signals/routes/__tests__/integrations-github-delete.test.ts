import { Buffer } from "node:buffer";
import { generateKeyPairSync, randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { githubInstallations } from "@vm0/db/schema/github-installation";
import { githubUserLinks } from "@vm0/db/schema/github-user-link";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";

import { createApp } from "../../../app-factory";
import { testContext } from "../../../__tests__/test-helpers";
import { server } from "../../../mocks/server";
import { clearMockedEnv, mockOptionalEnv } from "../../../lib/env";
import { writeDb$ } from "../../external/db";
import {
  deleteUsageInsightFixture$,
  seedCompose$,
} from "./helpers/zero-usage-insight";
import { createZeroRouteMocks } from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const ROUTE_PATH = "/api/integrations/github";

interface GithubInstallationFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly installationRowId: string;
}

function authHeaders(): Record<string, string> {
  return { authorization: "Bearer clerk-session" };
}

function newGithubUserId(): string {
  return `gh_${randomUUID().replaceAll("-", "")}`;
}

function newRemoteInstallationId(): string {
  return String(Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000);
}

function newPrivateKeyBase64(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  return Buffer.from(pem).toString("base64");
}

async function seedGithubInstallation(args: {
  readonly userId?: string;
  readonly linkedGithubUserId?: string;
  readonly adminGithubUserId?: string | null;
  readonly remoteInstallationId?: string | null;
}): Promise<GithubInstallationFixture> {
  const orgId = `org_${randomUUID()}`;
  const userId = args.userId ?? `user_${randomUUID()}`;
  const githubUserId = args.linkedGithubUserId ?? newGithubUserId();
  const adminGithubUserId =
    "adminGithubUserId" in args ? args.adminGithubUserId : githubUserId;
  const { composeId } = await store.set(
    seedCompose$,
    { orgId, userId },
    context.signal,
  );
  const db = store.set(writeDb$);

  const [installation] = await db
    .insert(githubInstallations)
    .values({
      installationId: args.remoteInstallationId ?? newRemoteInstallationId(),
      adminGithubUserId,
      defaultComposeId: composeId,
    })
    .returning({ id: githubInstallations.id });
  if (!installation) {
    throw new Error("Expected GitHub installation insert to return a row");
  }

  await db.insert(githubUserLinks).values({
    githubUserId,
    installationId: installation.id,
    vm0UserId: userId,
  });

  return { orgId, userId, installationRowId: installation.id };
}

async function deleteGithubFixture(
  fixture: GithubInstallationFixture,
): Promise<void> {
  const db = store.set(writeDb$);
  await db
    .delete(githubInstallations)
    .where(eq(githubInstallations.id, fixture.installationRowId));
  await store.set(
    deleteUsageInsightFixture$,
    { orgId: fixture.orgId, userId: fixture.userId },
    context.signal,
  );
}

async function installationExists(id: string): Promise<boolean> {
  const [row] = await store
    .set(writeDb$)
    .select({ id: githubInstallations.id })
    .from(githubInstallations)
    .where(eq(githubInstallations.id, id))
    .limit(1);
  return row !== undefined;
}

describe("DELETE /api/integrations/github", () => {
  const fixtures: GithubInstallationFixture[] = [];

  beforeEach(() => {
    clearMockedEnv();
    context.mocks.clerk.authenticateRequest.mockReset();
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
  });

  afterEach(async () => {
    clearMockedEnv();
    while (fixtures.length > 0) {
      const fixture = fixtures.pop();
      if (fixture) {
        await deleteGithubFixture(fixture);
      }
    }
  });

  it("returns 401 when no user is authenticated", async () => {
    const app = createApp({ signal: context.signal });

    const response = await app.request(ROUTE_PATH, { method: "DELETE" });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 404 when the authenticated user has no GitHub installation", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);
    const app = createApp({ signal: context.signal });

    const response = await app.request(ROUTE_PATH, {
      method: "DELETE",
      headers: authHeaders(),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "No GitHub installation found",
        code: "NOT_FOUND",
      },
    });
  });

  it("deletes the linked admin installation and returns ok", async () => {
    const fixture = await seedGithubInstallation({});
    fixtures.push(fixture);
    mocks.clerk.session(fixture.userId, null);
    const app = createApp({ signal: context.signal });

    const response = await app.request(ROUTE_PATH, {
      method: "DELETE",
      headers: authHeaders(),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ ok: true });
    await expect(
      installationExists(fixture.installationRowId),
    ).resolves.toBeFalsy();
  });

  it("returns 403 and keeps the installation when adminGithubUserId is null", async () => {
    const fixture = await seedGithubInstallation({ adminGithubUserId: null });
    fixtures.push(fixture);
    mocks.clerk.session(fixture.userId, null);
    const app = createApp({ signal: context.signal });

    const response = await app.request(ROUTE_PATH, {
      method: "DELETE",
      headers: authHeaders(),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Only the installation admin can uninstall",
        code: "FORBIDDEN",
      },
    });
    await expect(
      installationExists(fixture.installationRowId),
    ).resolves.toBeTruthy();
  });

  it("returns 403 and keeps the installation when a non-admin user deletes", async () => {
    const fixture = await seedGithubInstallation({
      adminGithubUserId: newGithubUserId(),
      linkedGithubUserId: newGithubUserId(),
    });
    fixtures.push(fixture);
    mocks.clerk.session(fixture.userId, null);
    const app = createApp({ signal: context.signal });

    const response = await app.request(ROUTE_PATH, {
      method: "DELETE",
      headers: authHeaders(),
    });

    expect(response.status).toBe(403);
    await expect(
      installationExists(fixture.installationRowId),
    ).resolves.toBeTruthy();
  });

  it("keeps local deletion authoritative when remote GitHub uninstall fails", async () => {
    const remoteInstallationId = newRemoteInstallationId();
    const fixture = await seedGithubInstallation({ remoteInstallationId });
    fixtures.push(fixture);
    mocks.clerk.session(fixture.userId, null);
    mockOptionalEnv("GITHUB_APP_ID", "123456");
    mockOptionalEnv("GITHUB_APP_PRIVATE_KEY", newPrivateKeyBase64());

    const observed: {
      authorization: string | null;
      installationId: string | null;
    } = {
      authorization: null,
      installationId: null,
    };
    server.use(
      http.delete(
        "https://api.github.com/app/installations/:installationId",
        ({ params, request }) => {
          observed.installationId = String(params.installationId);
          observed.authorization = request.headers.get("authorization");
          return HttpResponse.text("boom", { status: 500 });
        },
      ),
    );

    const app = createApp({ signal: context.signal });
    const response = await app.request(ROUTE_PATH, {
      method: "DELETE",
      headers: authHeaders(),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ ok: true });
    expect(observed.installationId).toBe(remoteInstallationId);
    expect(observed.authorization?.startsWith("Bearer ")).toBeTruthy();
    await expect(
      installationExists(fixture.installationRowId),
    ).resolves.toBeFalsy();
  });
});
