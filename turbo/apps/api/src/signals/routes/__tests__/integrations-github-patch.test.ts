import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { githubInstallations } from "@vm0/db/schema/github-installation";
import { githubUserLinks } from "@vm0/db/schema/github-user-link";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../../app-factory";
import { testContext } from "../../../__tests__/test-helpers";
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
  readonly defaultComposeId: string;
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

async function seedGithubInstallation(args: {
  readonly userId?: string;
  readonly linkedGithubUserId?: string;
  readonly adminGithubUserId?: string | null;
  readonly defaultComposeName?: string;
}): Promise<GithubInstallationFixture> {
  const orgId = `org_${randomUUID()}`;
  const userId = args.userId ?? `user_${randomUUID()}`;
  const githubUserId = args.linkedGithubUserId ?? newGithubUserId();
  const adminGithubUserId =
    "adminGithubUserId" in args ? args.adminGithubUserId : githubUserId;
  const { composeId } = await store.set(
    seedCompose$,
    {
      orgId,
      userId,
      name: args.defaultComposeName,
    },
    context.signal,
  );
  const db = store.set(writeDb$);

  const [installation] = await db
    .insert(githubInstallations)
    .values({
      installationId: newRemoteInstallationId(),
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

  return {
    orgId,
    userId,
    installationRowId: installation.id,
    defaultComposeId: composeId,
  };
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

async function seedAgent(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
}): Promise<{ readonly composeId: string }> {
  const { composeId } = await store.set(seedCompose$, args, context.signal);
  return { composeId };
}

async function defaultComposeId(installationRowId: string): Promise<string> {
  const [row] = await store
    .set(writeDb$)
    .select({ defaultComposeId: githubInstallations.defaultComposeId })
    .from(githubInstallations)
    .where(eq(githubInstallations.id, installationRowId))
    .limit(1);
  if (!row) {
    throw new Error("Expected GitHub installation to exist");
  }
  return row.defaultComposeId;
}

function patchGithub(body: string | undefined, headers: HeadersInit = {}) {
  const app = createApp({ signal: context.signal });
  return app.request(ROUTE_PATH, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body,
  });
}

describe("PATCH /api/integrations/github", () => {
  const fixtures: GithubInstallationFixture[] = [];

  beforeEach(() => {
    context.mocks.clerk.authenticateRequest.mockReset();
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
  });

  afterEach(async () => {
    while (fixtures.length > 0) {
      const fixture = fixtures.pop();
      if (fixture) {
        await deleteGithubFixture(fixture);
      }
    }
  });

  it("returns 401 when no user is authenticated", async () => {
    const response = await patchGithub(
      JSON.stringify({ agentName: "test-agent" }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 400 when agentName is missing", async () => {
    const fixture = await seedGithubInstallation({});
    fixtures.push(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await patchGithub(JSON.stringify({}), authHeaders());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "agentName is required", code: "BAD_REQUEST" },
    });
  });

  it("returns 400 when JSON is invalid", async () => {
    const fixture = await seedGithubInstallation({});
    fixtures.push(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await patchGithub("{", authHeaders());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "agentName is required", code: "BAD_REQUEST" },
    });
  });

  it("returns 400 when agentName is empty", async () => {
    const fixture = await seedGithubInstallation({});
    fixtures.push(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await patchGithub(
      JSON.stringify({ agentName: "" }),
      authHeaders(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "agentName is required", code: "BAD_REQUEST" },
    });
  });

  it("returns 404 when the authenticated user has no GitHub installation", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    const response = await patchGithub(
      JSON.stringify({ agentName: "test-agent" }),
      authHeaders(),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "No GitHub installation found",
        code: "NOT_FOUND",
      },
    });
  });

  it("returns 403 when adminGithubUserId is null", async () => {
    const fixture = await seedGithubInstallation({ adminGithubUserId: null });
    fixtures.push(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await patchGithub(
      JSON.stringify({ agentName: "test-agent" }),
      authHeaders(),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Only the installation admin can change the default agent",
        code: "FORBIDDEN",
      },
    });
    await expect(defaultComposeId(fixture.installationRowId)).resolves.toBe(
      fixture.defaultComposeId,
    );
  });

  it("returns 403 when a non-admin user updates the installation", async () => {
    const fixture = await seedGithubInstallation({
      adminGithubUserId: newGithubUserId(),
      linkedGithubUserId: newGithubUserId(),
    });
    fixtures.push(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await patchGithub(
      JSON.stringify({ agentName: "test-agent" }),
      authHeaders(),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Only the installation admin can change the default agent",
        code: "FORBIDDEN",
      },
    });
    await expect(defaultComposeId(fixture.installationRowId)).resolves.toBe(
      fixture.defaultComposeId,
    );
  });

  it("returns 400 when active org context is missing", async () => {
    const fixture = await seedGithubInstallation({});
    fixtures.push(fixture);
    mocks.clerk.session(fixture.userId, null);

    const response = await patchGithub(
      JSON.stringify({ agentName: "test-agent" }),
      authHeaders(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: {
        message: "Explicit org context required — ensure active org in session",
        code: "BAD_REQUEST",
      },
    });
  });

  it("returns 404 when the target agent does not exist", async () => {
    const fixture = await seedGithubInstallation({});
    fixtures.push(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await patchGithub(
      JSON.stringify({ agentName: "missing-agent" }),
      authHeaders(),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toStrictEqual({
      error: { message: "Agent not found", code: "NOT_FOUND" },
    });
    await expect(defaultComposeId(fixture.installationRowId)).resolves.toBe(
      fixture.defaultComposeId,
    );
  });

  it("updates the default agent", async () => {
    const fixture = await seedGithubInstallation({});
    fixtures.push(fixture);
    const targetName = `github-target-${randomUUID()}`;
    const target = await seedAgent({
      orgId: fixture.orgId,
      userId: fixture.userId,
      name: targetName,
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await patchGithub(
      JSON.stringify({ agentName: targetName }),
      authHeaders(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({ ok: true });
    await expect(defaultComposeId(fixture.installationRowId)).resolves.toBe(
      target.composeId,
    );
  });
});
