import { randomUUID } from "node:crypto";

import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { githubInstallations } from "@vm0/db/schema/github-installation";
import { githubLabelListeners } from "@vm0/db/schema/github-label-listener";
import { githubUserLinks } from "@vm0/db/schema/github-user-link";

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

describe("GitHub label listener integration routes", () => {
  const fixtures: GithubListenerFixture[] = [];

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
        await cleanupFixture(fixture);
      }
    }
  });

  it("creates, updates, and deletes a GitHub label listener", async () => {
    const fixture = await seedFixture();
    fixtures.push(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const app = createApp({ signal: context.signal });

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

    const deleteResponse = await app.request(
      `${ROUTE_PATH}/${created.listener.id}`,
      {
        method: "DELETE",
        headers: authHeaders(),
      },
    );

    expect(deleteResponse.status).toBe(200);
    await expect(listenerRows(fixture)).resolves.toHaveLength(0);
  });

  it("requires a GitHub user link for created-by-me listeners", async () => {
    const fixture = await seedFixture({ linked: false });
    fixtures.push(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const app = createApp({ signal: context.signal });

    const response = await app.request(ROUTE_PATH, {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        labelName: "Ready",
        triggerMode: "created_by_me",
        prompt: "Handle it",
        agentId: fixture.composeId,
      }),
    });

    expect(response.status).toBe(409);
    await expect(listenerRows(fixture)).resolves.toHaveLength(0);
  });

  it("rejects another org member updating or deleting a label listener", async () => {
    const fixture = await seedFixture();
    fixtures.push(fixture);
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
    const app = createApp({ signal: context.signal });

    const updateResponse = await app.request(`${ROUTE_PATH}/${listener.id}`, {
      method: "PATCH",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });

    expect(updateResponse.status).toBe(403);
    await expect(listenerRows(fixture)).resolves.toMatchObject([
      { enabled: true },
    ]);

    const deleteResponse = await app.request(`${ROUTE_PATH}/${listener.id}`, {
      method: "DELETE",
      headers: authHeaders(),
    });

    expect(deleteResponse.status).toBe(403);
    await expect(listenerRows(fixture)).resolves.toHaveLength(1);
  });

  it("allows an org admin to update and delete another user's label listener", async () => {
    const fixture = await seedFixture();
    fixtures.push(fixture);
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
    const adminUserId = `user_${randomUUID()}`;
    mocks.clerk.session(adminUserId, fixture.orgId, "org:admin");
    const app = createApp({ signal: context.signal });

    const updateResponse = await app.request(`${ROUTE_PATH}/${listener.id}`, {
      method: "PATCH",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });

    expect(updateResponse.status).toBe(200);
    await expect(listenerRows(fixture)).resolves.toMatchObject([
      { enabled: false },
    ]);

    const deleteResponse = await app.request(`${ROUTE_PATH}/${listener.id}`, {
      method: "DELETE",
      headers: authHeaders(),
    });

    expect(deleteResponse.status).toBe(200);
    await expect(listenerRows(fixture)).resolves.toHaveLength(0);
  });

  it("rejects duplicate labels for one installation", async () => {
    const fixture = await seedFixture();
    fixtures.push(fixture);
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const db = store.set(writeDb$);
    await db.insert(githubLabelListeners).values({
      installationId: fixture.installationId,
      orgId: fixture.orgId,
      createdByUserId: fixture.userId,
      labelName: "Ready",
      labelNameNormalized: "ready",
      triggerMode: "created_by_me",
      prompt: "Handle it",
      composeId: fixture.composeId,
    });
    const app = createApp({ signal: context.signal });

    const response = await app.request(ROUTE_PATH, {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({
        labelName: " ready ",
        triggerMode: "anyone",
        prompt: "Handle it again",
        agentId: fixture.composeId,
      }),
    });

    expect(response.status).toBe(409);
    await expect(
      db
        .select()
        .from(githubLabelListeners)
        .where(
          and(
            eq(githubLabelListeners.installationId, fixture.installationId),
            eq(githubLabelListeners.labelNameNormalized, "ready"),
          ),
        ),
    ).resolves.toHaveLength(1);
  });
});
