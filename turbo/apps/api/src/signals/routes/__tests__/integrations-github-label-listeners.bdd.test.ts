import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import type { ZeroCapability } from "@vm0/api-contracts/contracts/composes";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { githubInstallations } from "@vm0/db/schema/github-installation";
import { githubLabelListeners } from "@vm0/db/schema/github-label-listener";
import { githubUserLinks } from "@vm0/db/schema/github-user-link";

import { createApp } from "../../../app-factory";
import { testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { writeDb$ } from "../../external/db";
import {
  deleteUsageInsightFixture$,
  seedCompose$,
} from "./helpers/zero-usage-insight";
import { createZeroRouteMocks } from "./helpers/zero-route-test";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
  type OrgMembershipFixture,
} from "./helpers/zero-org-membership";

// BDD migration of the legacy
// `integrations-github-label-listeners.test.ts`. The 7
// legacy `it()`s collapse into 3 BDD `it()`s: (1)
// authorization chain (401 missing session → 403 missing
// `github:write` capability on a zero token → 403 another
// org member cannot update or delete → 200 org admin can
// update + delete another user's listener), (2) CRUD +
// uniqueness + missing-link chain (201 create → 200 update
// → 200 delete → 201 zero token with `github:write` can
// manage → 409 duplicate label on same installation → 409
// `created_by_me` requires a GitHub user link).

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);
const ROUTE_PATH = "/api/integrations/github/label-listeners";

interface GithubListenerFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly composeId: string;
  readonly installationId: string;
}

function authHeaders(): Record<string, string> {
  return { authorization: "Bearer clerk-session" };
}

function zeroToken(args: {
  readonly userId: string;
  readonly orgId: string;
  readonly capabilities: readonly ZeroCapability[];
}): string {
  const seconds = Math.floor(now() / 1000);
  return signSandboxJwtForTests({
    scope: "zero",
    userId: args.userId,
    orgId: args.orgId,
    runId: randomUUID(),
    capabilities: [...args.capabilities],
    iat: seconds,
    exp: seconds + 60,
  });
}

function newRemoteInstallationId(): string {
  return String(Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000);
}

async function seedFixture(
  args: {
    readonly linked?: boolean;
  } = {},
): Promise<GithubListenerFixture> {
  const orgId = `org_${randomUUID()}`;
  const userId = `user_${randomUUID()}`;
  const { composeId } = await store.set(
    seedCompose$,
    {
      orgId,
      userId,
      name: `github-listener-${randomUUID().slice(0, 8)}`,
    },
    context.signal,
  );
  const db = store.set(writeDb$);
  const [installation] = await db
    .insert(githubInstallations)
    .values({
      installationId: newRemoteInstallationId(),
      orgId,
      status: "active",
      defaultComposeId: composeId,
    })
    .returning({ id: githubInstallations.id });
  if (!installation) {
    throw new Error("Expected GitHub installation insert to return a row");
  }

  if (args.linked ?? true) {
    await db.insert(githubUserLinks).values({
      githubUserId: `gh_${randomUUID().replaceAll("-", "")}`,
      installationId: installation.id,
      vm0UserId: userId,
    });
  }

  return { orgId, userId, composeId, installationId: installation.id };
}

async function cleanupFixture(fixture: GithubListenerFixture): Promise<void> {
  await store
    .set(writeDb$)
    .delete(githubInstallations)
    .where(eq(githubInstallations.id, fixture.installationId));
  await store.set(
    deleteUsageInsightFixture$,
    { orgId: fixture.orgId, userId: fixture.userId },
    context.signal,
  );
}

async function listenerRows(fixture: GithubListenerFixture) {
  return await store
    .set(writeDb$)
    .select()
    .from(githubLabelListeners)
    .where(eq(githubLabelListeners.installationId, fixture.installationId));
}

function createGithubListenerHarness(): {
  readonly fixtures: GithubListenerFixture[];
  readonly membershipFixtures: OrgMembershipFixture[];
  readonly track: (fixture: GithubListenerFixture) => void;
  readonly trackMembership: (fixture: OrgMembershipFixture) => void;
} {
  const fixtures: GithubListenerFixture[] = [];
  const membershipFixtures: OrgMembershipFixture[] = [];
  const track = (fixture: GithubListenerFixture) => {
    fixtures.push(fixture);
  };
  const trackMembership = (fixture: OrgMembershipFixture) => {
    membershipFixtures.push(fixture);
  };
  return { fixtures, membershipFixtures, track, trackMembership };
}

describe("BDD GitHub label listener integration routes — authorization chain", () => {
  const harness = createGithubListenerHarness();

  beforeEach(() => {
    context.mocks.clerk.authenticateRequest.mockReset();
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
  });

  afterEach(async () => {
    while (harness.fixtures.length > 0) {
      const fixture = harness.fixtures.pop();
      if (fixture) {
        await cleanupFixture(fixture);
      }
    }
    while (harness.membershipFixtures.length > 0) {
      const fixture = harness.membershipFixtures.pop();
      if (fixture) {
        await store.set(deleteOrgMembership$, fixture, context.signal);
      }
    }
  });

  it("gwt-wt-wt: 401 missing session → 403 missing github:write capability → 403 another org member cannot update or delete → 200 org admin can update + delete another user's listener", async () => {
    // Given: no authenticated session.

    // When + Then: 401 — unauthorized.
    const app = createApp({ signal: context.signal });
    const noAuthResponse = await app.request(ROUTE_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        labelName: "Ready",
        triggerMode: "anyone",
        prompt: "Handle this issue",
        agentId: randomUUID(),
      }),
    });
    expect(noAuthResponse.status).toBe(401);

    // Given: a zero token with only `github:read`.

    // When + Then: 403 — missing github:write capability.
    const insufficientResponse = await app.request(ROUTE_PATH, {
      method: "POST",
      headers: {
        authorization: `Bearer ${zeroToken({
          userId: `user_${randomUUID()}`,
          orgId: `org_${randomUUID()}`,
          capabilities: ["github:read"],
        })}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        labelName: "Ready",
        triggerMode: "anyone",
        prompt: "Handle this issue",
        agentId: randomUUID(),
      }),
    });
    expect(insufficientResponse.status).toBe(403);
    await expect(insufficientResponse.json()).resolves.toStrictEqual({
      error: {
        message: "Missing required capability: github:write",
        code: "FORBIDDEN",
      },
    });

    // Given: a fixture owned by a different org member.
    const fixture = await seedFixture();
    harness.track(fixture);
    const db = store.set(writeDb$);
    const [listener] = await db
      .insert(githubLabelListeners)
      .values({
        installationId: fixture.installationId,
        orgId: fixture.orgId,
        createdByUserId: fixture.userId,
        labelName: "Ready",
        labelNameNormalized: "ready",
        triggerMode: "created_by_me",
        prompt: "Handle it",
        composeId: fixture.composeId,
      })
      .returning({ id: githubLabelListeners.id });
    if (!listener) {
      throw new Error("Expected label listener insert to return a row");
    }
    const otherUserId = `user_${randomUUID()}`;
    mocks.clerk.session(otherUserId, fixture.orgId, "org:member");

    // When + Then: 403 — another org member cannot
    // update the listener.
    const otherUpdateResponse = await app.request(
      `${ROUTE_PATH}/${listener.id}`,
      {
        method: "PATCH",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      },
    );
    expect(otherUpdateResponse.status).toBe(403);
    await expect(listenerRows(fixture)).resolves.toMatchObject([
      { enabled: true },
    ]);

    // When + Then: 403 — another org member cannot
    // delete the listener.
    const otherDeleteResponse = await app.request(
      `${ROUTE_PATH}/${listener.id}`,
      {
        method: "DELETE",
        headers: authHeaders(),
      },
    );
    expect(otherDeleteResponse.status).toBe(403);
    await expect(listenerRows(fixture)).resolves.toHaveLength(1);

    // Given: a different org admin session.
    const adminUserId = `user_${randomUUID()}`;
    mocks.clerk.session(adminUserId, fixture.orgId, "org:admin");

    // When + Then: 200 — the admin can update the
    // listener.
    const adminUpdateResponse = await app.request(
      `${ROUTE_PATH}/${listener.id}`,
      {
        method: "PATCH",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      },
    );
    expect(adminUpdateResponse.status).toBe(200);
    await expect(listenerRows(fixture)).resolves.toMatchObject([
      { enabled: false },
    ]);

    // When + Then: 200 — the admin can delete the
    // listener.
    const adminDeleteResponse = await app.request(
      `${ROUTE_PATH}/${listener.id}`,
      {
        method: "DELETE",
        headers: authHeaders(),
      },
    );
    expect(adminDeleteResponse.status).toBe(200);
    await expect(listenerRows(fixture)).resolves.toHaveLength(0);
  });
});

describe("BDD GitHub label listener integration routes — CRUD + uniqueness + missing-link chain", () => {
  const harness = createGithubListenerHarness();

  beforeEach(() => {
    context.mocks.clerk.authenticateRequest.mockReset();
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
    });
  });

  afterEach(async () => {
    while (harness.fixtures.length > 0) {
      const fixture = harness.fixtures.pop();
      if (fixture) {
        await cleanupFixture(fixture);
      }
    }
    while (harness.membershipFixtures.length > 0) {
      const fixture = harness.membershipFixtures.pop();
      if (fixture) {
        await store.set(deleteOrgMembership$, fixture, context.signal);
      }
    }
  });

  it("gwt-wt-wt: 201 session create → 200 update → 200 delete → 201 zero token with github:write can manage → 409 duplicate label on same installation → 409 created_by_me requires a GitHub user link", async () => {
    // Given: a fixture with a linked GitHub user.
    const fixture = await seedFixture();
    harness.track(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const app = createApp({ signal: context.signal });

    // When + Then: 201 — a session-authenticated POST
    // creates a listener with normalized labelName.
    const createResponse = await app.request(ROUTE_PATH, {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        labelName: "Ready For Zero",
        triggerMode: "anyone",
        prompt: "Handle this issue",
        agentId: fixture.composeId,
      }),
    });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as {
      readonly listener: { readonly id: string };
    };
    await expect(listenerRows(fixture)).resolves.toMatchObject([
      {
        labelName: "Ready For Zero",
        labelNameNormalized: "ready for zero",
        triggerMode: "anyone",
        prompt: "Handle this issue",
      },
    ]);

    // When + Then: 200 — PATCH updates label + mode +
    // prompt + disables the listener.
    const updateResponse = await app.request(
      `${ROUTE_PATH}/${created.listener.id}`,
      {
        method: "PATCH",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({
          labelName: "Needs Agent",
          triggerMode: "created_by_me",
          prompt: "Review and fix",
          enabled: false,
        }),
      },
    );
    expect(updateResponse.status).toBe(200);
    await expect(listenerRows(fixture)).resolves.toMatchObject([
      {
        labelName: "Needs Agent",
        labelNameNormalized: "needs agent",
        triggerMode: "created_by_me",
        prompt: "Review and fix",
        enabled: false,
      },
    ]);

    // When + Then: 200 — DELETE removes the listener.
    const deleteResponse = await app.request(
      `${ROUTE_PATH}/${created.listener.id}`,
      {
        method: "DELETE",
        headers: authHeaders(),
      },
    );
    expect(deleteResponse.status).toBe(200);
    await expect(listenerRows(fixture)).resolves.toHaveLength(0);

    // Given: a fixture for zero-token CRUD.
    const zeroFixture = await seedFixture();
    harness.track(zeroFixture);
    harness.trackMembership(
      await store.set(
        seedOrgMembership$,
        {
          orgId: zeroFixture.orgId,
          userId: zeroFixture.userId,
          role: "member",
        },
        context.signal,
      ),
    );
    const zeroAuth = `Bearer ${zeroToken({
      userId: zeroFixture.userId,
      orgId: zeroFixture.orgId,
      capabilities: ["github:write"],
    })}`;

    // When + Then: 201 — zero token with `github:write`
    // can create.
    const zeroCreateResponse = await app.request(ROUTE_PATH, {
      method: "POST",
      headers: { authorization: zeroAuth, "content-type": "application/json" },
      body: JSON.stringify({
        labelName: "Ready For Zero",
        triggerMode: "anyone",
        prompt: "Handle this issue",
        agentId: zeroFixture.composeId,
      }),
    });
    expect(zeroCreateResponse.status).toBe(201);
    const zeroCreated = (await zeroCreateResponse.json()) as {
      readonly listener: { readonly id: string };
    };

    // When + Then: 200 — zero token can update.
    const zeroUpdateResponse = await app.request(
      `${ROUTE_PATH}/${zeroCreated.listener.id}`,
      {
        method: "PATCH",
        headers: {
          authorization: zeroAuth,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          labelName: "Needs Agent",
          prompt: "Review and fix",
        }),
      },
    );
    expect(zeroUpdateResponse.status).toBe(200);

    // When + Then: 200 — zero token can delete.
    const zeroDeleteResponse = await app.request(
      `${ROUTE_PATH}/${zeroCreated.listener.id}`,
      {
        method: "DELETE",
        headers: { authorization: zeroAuth },
      },
    );
    expect(zeroDeleteResponse.status).toBe(200);
    await expect(listenerRows(zeroFixture)).resolves.toHaveLength(0);

    // Given: a fixture + an existing label listener.

    // When + Then: 409 — duplicate label (after
    // normalization) on same installation is rejected.
    const dupFixture = await seedFixture();
    harness.track(dupFixture);
    mocks.clerk.session(dupFixture.userId, dupFixture.orgId);
    const dupDb = store.set(writeDb$);
    await dupDb.insert(githubLabelListeners).values({
      installationId: dupFixture.installationId,
      orgId: dupFixture.orgId,
      createdByUserId: dupFixture.userId,
      labelName: "Ready",
      labelNameNormalized: "ready",
      triggerMode: "created_by_me",
      prompt: "Handle it",
      composeId: dupFixture.composeId,
    });
    const duplicateResponse = await app.request(ROUTE_PATH, {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        labelName: " ready ",
        triggerMode: "anyone",
        prompt: "Handle it again",
        agentId: dupFixture.composeId,
      }),
    });
    expect(duplicateResponse.status).toBe(409);
    await expect(
      dupDb
        .select()
        .from(githubLabelListeners)
        .where(
          and(
            eq(githubLabelListeners.installationId, dupFixture.installationId),
            eq(githubLabelListeners.labelNameNormalized, "ready"),
          ),
        ),
    ).resolves.toHaveLength(1);

    // Given: a fixture with NO GitHub user link.

    // When + Then: 409 — `created_by_me` requires a
    // GitHub user link.
    const unlinkedFixture = await seedFixture({ linked: false });
    harness.track(unlinkedFixture);
    mocks.clerk.session(unlinkedFixture.userId, unlinkedFixture.orgId);
    const unlinkedResponse = await app.request(ROUTE_PATH, {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        labelName: "Ready",
        triggerMode: "created_by_me",
        prompt: "Handle it",
        agentId: unlinkedFixture.composeId,
      }),
    });
    expect(unlinkedResponse.status).toBe(409);
    await expect(listenerRows(unlinkedFixture)).resolves.toHaveLength(0);
  });
});
