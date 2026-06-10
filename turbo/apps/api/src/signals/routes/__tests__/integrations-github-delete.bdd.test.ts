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

// BDD migration of the legacy `integrations-github-delete.test.ts`.
// The 8 legacy `it()`s collapse into 3 BDD `it()`s: (1) auth
// chain (401 unauth → 404 no installation), (2) success chain
// (200 deletes linked admin installation + Ably publish →
// 200 deletes installation before GitHub is connected), (3)
// 403 chain (403 org member with adminGithubUserId null → 403
// non-admin org member → 403 non-admin org member when admin
// is not in the org → 200 local deletion authoritative when
// remote uninstall fails).
//
// Service-Level Exception: `githubInstallations` and
// `githubUserLinks` rows are seeded directly via `writeDb$`
// because no public route creates them. The `fixtures` array
// is closed over a `createHarness()` factory inside each
// describe so the mutable package-scope lint rule
// (`api/no-package-variable`) is satisfied.

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
  readonly link?: boolean;
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
      orgId,
      adminGithubUserId,
      defaultComposeId: composeId,
    })
    .returning({ id: githubInstallations.id });
  if (!installation) {
    throw new Error("Expected GitHub installation insert to return a row");
  }

  if (args.link !== false) {
    await db.insert(githubUserLinks).values({
      githubUserId,
      installationId: installation.id,
      vm0UserId: userId,
    });
  }

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

function createHarness(): {
  readonly fixtures: GithubInstallationFixture[];
  readonly seedAndTrack: (args: Parameters<typeof seedGithubInstallation>[0]) => Promise<GithubInstallationFixture>;
} {
  const fixtures: GithubInstallationFixture[] = [];

  afterEach(async () => {
    clearMockedEnv();
    while (fixtures.length > 0) {
      const fixture = fixtures.pop();
      if (fixture) {
        await deleteGithubFixture(fixture);
      }
    }
  });

  const seedAndTrack = async (
    args: Parameters<typeof seedGithubInstallation>[0],
  ): Promise<GithubInstallationFixture> => {
    const fixture = await seedGithubInstallation(args);
    fixtures.push(fixture);
    return fixture;
  };

  return { fixtures, seedAndTrack };
}

describe("BDD DELETE /api/integrations/github — auth + 404 chain", () => {
  beforeEach(() => {
    clearMockedEnv();
    context.mocks.clerk.authenticateRequest.mockReset();
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
  });

  it("gwt-wt-wt: 401 unauth → 404 no installation", async () => {
    // When + Then: 401 — no auth header.
    const app = createApp({ signal: context.signal });
    const noAuth = await app.request(ROUTE_PATH, { method: "DELETE" });
    expect(noAuth.status).toBe(401);
    await expect(noAuth.json()).resolves.toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a session with a user but no GitHub installation.
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    // When + Then: 404.
    const notInstalled = await app.request(ROUTE_PATH, {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(notInstalled.status).toBe(404);
    await expect(notInstalled.json()).resolves.toStrictEqual({
      error: {
        message: "No GitHub installation found",
        code: "NOT_FOUND",
      },
    });
  });
});

describe("BDD DELETE /api/integrations/github — 200 success chain", () => {
  const { seedAndTrack } = createHarness();

  beforeEach(() => {
    clearMockedEnv();
    context.mocks.clerk.authenticateRequest.mockReset();
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
  });

  it("gwt-wt-wt: 200 deletes linked admin installation + Ably publish → 200 deletes installation before GitHub is connected", async () => {
    // Given: a fresh GitHub installation with an admin link.
    const linked = await seedAndTrack({});
    mocks.clerk.session(linked.userId, linked.orgId);
    context.mocks.ably.publish.mockClear();
    const app = createApp({ signal: context.signal });

    // When + Then: 200 — the installation is deleted + Ably
    // publishes `github:changed` with null payload.
    const linkedResponse = await app.request(ROUTE_PATH, {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(linkedResponse.status).toBe(200);
    await expect(linkedResponse.json()).resolves.toStrictEqual({ ok: true });
    await expect(
      installationExists(linked.installationRowId),
    ).resolves.toBeFalsy();
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "github:changed",
      null,
    );

    // Given: a fresh installation without a user link.
    const unlinked = await seedAndTrack({ link: false });
    mocks.clerk.session(unlinked.userId, unlinked.orgId);
    context.mocks.ably.publish.mockClear();

    // When + Then: 200 — the unlinked installation is
    // deleted (org admin can still uninstall).
    const unlinkedResponse = await app.request(ROUTE_PATH, {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(unlinkedResponse.status).toBe(200);
    await expect(unlinkedResponse.json()).resolves.toStrictEqual({ ok: true });
    await expect(
      installationExists(unlinked.installationRowId),
    ).resolves.toBeFalsy();
  });
});

describe("BDD DELETE /api/integrations/github — 403 forbidden chain", () => {
  const { seedAndTrack } = createHarness();

  beforeEach(() => {
    clearMockedEnv();
    context.mocks.clerk.authenticateRequest.mockReset();
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
  });

  it("gwt-wt-wt: 403 org member with adminGithubUserId null → 403 non-admin org member → 403 non-admin org member when admin is not in the org → 200 local deletion authoritative when remote uninstall fails", async () => {
    // Given: a fresh installation with adminGithubUserId
    // null and a member-role Clerk session.
    const memberNull = await seedAndTrack({ adminGithubUserId: null });
    mocks.clerk.session(memberNull.userId, memberNull.orgId, "org:member");
    const app = createApp({ signal: context.signal });

    // When + Then: 403.
    const memberNullResponse = await app.request(ROUTE_PATH, {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(memberNullResponse.status).toBe(403);
    await expect(memberNullResponse.json()).resolves.toStrictEqual({
      error: {
        message: "Only organization admins can uninstall GitHub",
        code: "FORBIDDEN",
      },
    });
    await expect(
      installationExists(memberNull.installationRowId),
    ).resolves.toBeTruthy();

    // Given: a fresh installation with a different
    // adminGithubUserId and a member-role session.
    const nonAdmin = await seedAndTrack({
      adminGithubUserId: newGithubUserId(),
      linkedGithubUserId: newGithubUserId(),
    });
    mocks.clerk.session(nonAdmin.userId, nonAdmin.orgId, "org:member");

    // When + Then: 403 — installation is preserved.
    const nonAdminResponse = await app.request(ROUTE_PATH, {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(nonAdminResponse.status).toBe(403);
    await expect(
      installationExists(nonAdmin.installationRowId),
    ).resolves.toBeTruthy();

    // Given: a fresh installation with a default admin and
    // a member-role session where the admin is not in the
    // org.
    const notInOrg = await seedAndTrack({});
    mocks.clerk.session(notInOrg.userId, notInOrg.orgId, "org:member");

    // When + Then: 403 — installation is preserved.
    const notInOrgResponse = await app.request(ROUTE_PATH, {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(notInOrgResponse.status).toBe(403);
    await expect(
      installationExists(notInOrg.installationRowId),
    ).resolves.toBeTruthy();

    // Given: a fresh installation with a remote ID + the
    // GitHub app credentials env + an MSW handler that
    // returns 500 on the remote uninstall call.
    const remoteInstallationId = newRemoteInstallationId();
    const remote = await seedAndTrack({ remoteInstallationId });
    mocks.clerk.session(remote.userId, remote.orgId);
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

    // When + Then: 200 — local deletion is authoritative;
    // the upstream call was attempted with a Bearer token.
    const remoteResponse = await app.request(ROUTE_PATH, {
      method: "DELETE",
      headers: authHeaders(),
    });
    expect(remoteResponse.status).toBe(200);
    await expect(remoteResponse.json()).resolves.toStrictEqual({ ok: true });
    expect(observed.installationId).toBe(remoteInstallationId);
    expect(observed.authorization?.startsWith("Bearer ")).toBeTruthy();
    await expect(
      installationExists(remote.installationRowId),
    ).resolves.toBeFalsy();
  });
});
