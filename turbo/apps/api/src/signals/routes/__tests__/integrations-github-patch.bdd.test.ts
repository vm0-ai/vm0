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

// BDD migration of the legacy
// `integrations-github-patch.test.ts`. The 12 legacy
// `it()`s collapse into 3 BDD `it()`s: (1) auth + bad-body
// chain (401 unauthenticated → 400 missing agentName → 400
// invalid JSON → 400 empty agentName → 400 missing org →
// 404 no installation), (2) admin authorization chain
// (403 org member with null admin → 403 org member with
// different admin → 403 GitHub admin who is not org
// admin), (3) success chain (404 target agent not found
// → 200 admin updates default agent → 200 admin updates
// default agent before GitHub is connected).
//
// Service-Level Exception: `githubInstallations` and
// `githubUserLinks` rows are seeded directly via
// `writeDb$` because no public route creates them. The
// installation's `defaultComposeId` is read back directly
// via `writeDb$` to verify PATCH side effects because no
// public follow-up GET endpoint exists.

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
  readonly link?: boolean;
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

function createGithubHarness(): {
  readonly fixtures: GithubInstallationFixture[];
  readonly track: (
    fixture: GithubInstallationFixture,
  ) => GithubInstallationFixture;
} {
  const fixtures: GithubInstallationFixture[] = [];
  const track = (fixture: GithubInstallationFixture) => {
    fixtures.push(fixture);
    return fixture;
  };
  return { fixtures, track };
}

describe("BDD PATCH /api/integrations/github — auth + bad-body chain", () => {
  const { fixtures, track } = createGithubHarness();

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

  it("gwt-wt-wt: 401 unauthenticated → 400 missing agentName → 400 invalid JSON → 400 empty agentName → 400 missing org → 404 no installation", async () => {
    // Given: no authenticated session (the beforeEach
    // sets `isAuthenticated: false` as the default).

    // When + Then: 401.
    const noAuth = await patchGithub(
      JSON.stringify({ agentName: "test-agent" }),
    );
    expect(noAuth.status).toBe(401);
    await expect(noAuth.json()).resolves.toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: an authenticated session for a fresh
    // GitHub installation.
    const missingFixture = track(await seedGithubInstallation({}));
    mocks.clerk.session(missingFixture.userId, missingFixture.orgId);

    // When + Then: 400 — missing agentName.
    const missingAgentName = await patchGithub(
      JSON.stringify({}),
      authHeaders(),
    );
    expect(missingAgentName.status).toBe(400);
    await expect(missingAgentName.json()).resolves.toStrictEqual({
      error: { message: "agentName is required", code: "BAD_REQUEST" },
    });

    // When + Then: 400 — invalid JSON.
    const invalidJson = await patchGithub("{", authHeaders());
    expect(invalidJson.status).toBe(400);
    await expect(invalidJson.json()).resolves.toStrictEqual({
      error: { message: "agentName is required", code: "BAD_REQUEST" },
    });

    // When + Then: 400 — empty agentName.
    const emptyAgentName = await patchGithub(
      JSON.stringify({ agentName: "" }),
      authHeaders(),
    );
    expect(emptyAgentName.status).toBe(400);
    await expect(emptyAgentName.json()).resolves.toStrictEqual({
      error: { message: "agentName is required", code: "BAD_REQUEST" },
    });

    // Given: a session with no org context.
    mocks.clerk.session(missingFixture.userId, null);

    // When + Then: 400 — missing org.
    const missingOrg = await patchGithub(
      JSON.stringify({ agentName: "test-agent" }),
      authHeaders(),
    );
    expect(missingOrg.status).toBe(400);
    await expect(missingOrg.json()).resolves.toStrictEqual({
      error: {
        message: "Explicit org context required — ensure active org in session",
        code: "BAD_REQUEST",
      },
    });

    // Given: an authenticated session for a user with no
    // GitHub installation.
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);

    // When + Then: 404.
    const noInstall = await patchGithub(
      JSON.stringify({ agentName: "test-agent" }),
      authHeaders(),
    );
    expect(noInstall.status).toBe(404);
    await expect(noInstall.json()).resolves.toStrictEqual({
      error: { message: "No GitHub installation found", code: "NOT_FOUND" },
    });
  });
});

describe("BDD PATCH /api/integrations/github — admin authorization chain", () => {
  beforeEach(() => {
    context.mocks.clerk.authenticateRequest.mockReset();
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
  });

  afterEach(async () => {
    const db = store.set(writeDb$);
    await db.delete(githubInstallations);
  });

  it("gwt-wt-wt: 403 org member with null admin → 403 org member with different admin → 403 GitHub admin who is not org admin", async () => {
    // Given: an installation with null admin + a member
    // session.
    const nullAdminFixture = await seedGithubInstallation({
      adminGithubUserId: null,
    });
    mocks.clerk.session(
      nullAdminFixture.userId,
      nullAdminFixture.orgId,
      "org:member",
    );

    // When + Then: 403 — only org admins can change the
    // default agent; default agent is unchanged.
    const nullAdminResponse = await patchGithub(
      JSON.stringify({ agentName: "test-agent" }),
      authHeaders(),
    );
    expect(nullAdminResponse.status).toBe(403);
    await expect(nullAdminResponse.json()).resolves.toStrictEqual({
      error: {
        message: "Only organization admins can change the default agent",
        code: "FORBIDDEN",
      },
    });
    await expect(
      defaultComposeId(nullAdminFixture.installationRowId),
    ).resolves.toBe(nullAdminFixture.defaultComposeId);

    // Given: an installation with a different admin + a
    // member session.
    const otherAdminFixture = await seedGithubInstallation({
      adminGithubUserId: newGithubUserId(),
      linkedGithubUserId: newGithubUserId(),
    });
    mocks.clerk.session(
      otherAdminFixture.userId,
      otherAdminFixture.orgId,
      "org:member",
    );

    // When + Then: 403 — non-admin is rejected; default
    // agent is unchanged.
    const otherAdminResponse = await patchGithub(
      JSON.stringify({ agentName: "test-agent" }),
      authHeaders(),
    );
    expect(otherAdminResponse.status).toBe(403);
    await expect(otherAdminResponse.json()).resolves.toStrictEqual({
      error: {
        message: "Only organization admins can change the default agent",
        code: "FORBIDDEN",
      },
    });
    await expect(
      defaultComposeId(otherAdminFixture.installationRowId),
    ).resolves.toBe(otherAdminFixture.defaultComposeId);

    // Given: an installation with the user as the GitHub
    // admin + a member session.
    const notOrgAdminFixture = await seedGithubInstallation({});
    mocks.clerk.session(
      notOrgAdminFixture.userId,
      notOrgAdminFixture.orgId,
      "org:member",
    );

    // When + Then: 403 — GitHub admin who is not org
    // admin is rejected; default agent is unchanged.
    const notOrgAdminResponse = await patchGithub(
      JSON.stringify({ agentName: "test-agent" }),
      authHeaders(),
    );
    expect(notOrgAdminResponse.status).toBe(403);
    await expect(
      defaultComposeId(notOrgAdminFixture.installationRowId),
    ).resolves.toBe(notOrgAdminFixture.defaultComposeId);
  });
});

describe("BDD PATCH /api/integrations/github — success chain", () => {
  beforeEach(() => {
    context.mocks.clerk.authenticateRequest.mockReset();
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
  });

  afterEach(async () => {
    const db = store.set(writeDb$);
    await db.delete(githubInstallations);
  });

  it("gwt-wt-wt: 404 target agent not found → 200 admin updates default agent → 200 admin updates default agent before GitHub is connected", async () => {
    // Given: an admin session for a fresh installation.
    const fixture = await seedGithubInstallation({});
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When + Then: 404 — target agent does not exist;
    // default agent is unchanged.
    const missingAgent = await patchGithub(
      JSON.stringify({ agentName: "missing-agent" }),
      authHeaders(),
    );
    expect(missingAgent.status).toBe(404);
    await expect(missingAgent.json()).resolves.toStrictEqual({
      error: { message: "Agent not found", code: "NOT_FOUND" },
    });
    await expect(defaultComposeId(fixture.installationRowId)).resolves.toBe(
      fixture.defaultComposeId,
    );

    // Given: the same admin session + a new target
    // agent.
    const targetName = `github-target-${randomUUID()}`;
    const target = await seedAgent({
      orgId: fixture.orgId,
      userId: fixture.userId,
      name: targetName,
    });

    // When + Then: 200 — default agent is updated.
    const updatedResponse = await patchGithub(
      JSON.stringify({ agentName: targetName }),
      authHeaders(),
    );
    expect(updatedResponse.status).toBe(200);
    await expect(updatedResponse.json()).resolves.toStrictEqual({ ok: true });
    await expect(defaultComposeId(fixture.installationRowId)).resolves.toBe(
      target.composeId,
    );

    // Given: a fresh installation without a GitHub link
    // + an admin session + a new target agent.
    const unlinkedFixture = await seedGithubInstallation({ link: false });
    mocks.clerk.session(unlinkedFixture.userId, unlinkedFixture.orgId);
    const unlinkedTargetName = `github-target-${randomUUID()}`;
    const unlinkedTarget = await seedAgent({
      orgId: unlinkedFixture.orgId,
      userId: unlinkedFixture.userId,
      name: unlinkedTargetName,
    });

    // When + Then: 200 — admin can update the default
    // agent even before GitHub is connected.
    const unlinkedResponse = await patchGithub(
      JSON.stringify({ agentName: unlinkedTargetName }),
      authHeaders(),
    );
    expect(unlinkedResponse.status).toBe(200);
    await expect(unlinkedResponse.json()).resolves.toStrictEqual({ ok: true });
    await expect(
      defaultComposeId(unlinkedFixture.installationRowId),
    ).resolves.toBe(unlinkedTarget.composeId);
  });
});
